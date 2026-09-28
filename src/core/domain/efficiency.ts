import { ENERGY_ASSUMPTIONS } from "@/config/constants";
import type { KilnFlow } from "./types";

// F-14 efficiency report (Architecture 9 EfficiencyReport, 관측성 "에너지 추정 가정", D-20). Pure: the SQLite
// aggregate (KilnCallRepo.aggregateByFlow) or an exported evidence file feeds it the same FlowAggregate rows.


/** One row of KilnCallRepo.aggregateByFlow = kiln_calls filtered by (chain_id, vault, provider), GROUP BY flow (D-33). */
export type FlowAggregate = {
    flow: KilnFlow;
    kilnCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens: number | null;
    costUsd: string;
    latencyMsSum: number;
    generationIds: string[];
};

/** The usage fields of a Kiln call record (KilnCallRecord / KilnCallExport). */
export type UsageCall = {
    flow: KilnFlow;
    provider: "kiln" | "fake";
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number | null;
    totalTokens: number;
    costUsd: string | null;
    latencyMs: number;
    generationId: string | null;
    createdAt: string;
};

export type EfficiencyFlow = KilnFlow | "rule_block";
export type EfficiencyRow = {
    flow: EfficiencyFlow;
    kilnCalls: number;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number | null;
    totalTokens: number;
    costUsd: string;
    generationIds: string[];
    energyWhUpper: number;
};

export type EfficiencyReport = {
    provider: "kiln" | "fake";
    rows: EfficiencyRow[];
    totals: { kilnCalls: number; promptTokens: number; completionTokens: number; reasoningTokens: number | null; totalTokens: number; costUsd: string; energyWhUpper: number };
    savings: { ruleBlockedRequests: number; avoidedTokensEstimate: number; avoidedEnergyWhUpper: number };
    energy: { formula: string; assumptions: { name: string; value: number; unit: string; source: string }[]; disclaimer: string };
};

const FLOW_ORDER: KilnFlow[] = ["policy_parse", "intent_judge"];
const REQUEST_FLOWS = new Set(["rule_block", "intent_judge"]);

/** E_Wh = latency_s × cards × P_card_W ÷ 3600 — upper bound, not a measurement. */
export function energyWhUpper(latencyMs: number): number {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new RangeError(`latency must be a non-negative number, got ${latencyMs}`);
    return ((latencyMs / 1000) * ENERGY_ASSUMPTIONS.cards.value * ENERGY_ASSUMPTIONS.cardPowerW.value) / 3600;
}

function usd(value: string | null): number {
    if (value === null) return 0;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new RangeError(`cost is not a number: ${value}`);
    return n;
}

/** USD as a decimal string, rounded to 10 places (hides float noise; Kiln reports 8 decimals). */
function formatUsd(n: number): string {
    return String(Number(n.toFixed(10)));
}

const addNullable = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : a + b);

/** The same aggregation as the SQL in KilnCallRepo.aggregateByFlow, for calls read from an evidence export. */
export function aggregateCalls(calls: UsageCall[], provider: "kiln" | "fake"): FlowAggregate[] {
    const out: FlowAggregate[] = [];
    for (const flow of FLOW_ORDER) {
        const mine = calls.filter((c) => c.provider === provider && c.flow === flow).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (mine.length === 0) continue;
        out.push({
            flow,
            kilnCalls: mine.length,
            promptTokens: mine.reduce((s, c) => s + c.promptTokens, 0),
            completionTokens: mine.reduce((s, c) => s + c.completionTokens, 0),
            totalTokens: mine.reduce((s, c) => s + c.totalTokens, 0),
            reasoningTokens: mine.reduce<number | null>((s, c) => addNullable(s, c.reasoningTokens), null),
            costUsd: formatUsd(mine.reduce((s, c) => s + usd(c.costUsd), 0)),
            latencyMsSum: mine.reduce((s, c) => s + c.latencyMs, 0),
            generationIds: mine.flatMap((c) => (c.generationId === null ? [] : [c.generationId])),
        });
    }
    return out;
}

/** spend_request evidence → request flow: pre-check block = rule_block (no Kiln call), pass = intent_judge. */
export function requestFlowCounts(records: { kind: string; package: unknown }[]): { flow: string; n: number }[] {
    const counts = new Map<string, number>();
    for (const r of records) {
        if (r.kind !== "spend_request") continue;
        const verdict = (r.package as { precheck?: { verdict?: unknown } } | null)?.precheck?.verdict;
        const flow = verdict === "block" ? "rule_block" : "intent_judge";
        counts.set(flow, (counts.get(flow) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([flow, n]) => ({ flow, n }));
}

/**
 * Rows: one per Kiln flow with calls (policy_parse requests = its calls; intent_judge requests = judged spend requests),
 * plus rule_block (0 Kiln calls, 0 tokens) when any request was blocked by the pre-check. Totals are the sums of the
 * Kiln rows. Savings = rule-blocked requests × the intent_judge per-call average (Architecture 관측성 "절감 추정").
 */
export function composeEfficiencyReport(provider: "kiln" | "fake", aggregates: FlowAggregate[], requestCounts: { flow: string; n: number }[]): EfficiencyReport {
    for (const c of requestCounts) if (!REQUEST_FLOWS.has(c.flow)) throw new RangeError(`unknown request flow: ${c.flow}`);
    const requests = (flow: string) => requestCounts.find((c) => c.flow === flow)?.n ?? 0;

    const rows: EfficiencyRow[] = aggregates.map((a) => ({
        flow: a.flow,
        kilnCalls: a.kilnCalls,
        requests: a.flow === "policy_parse" ? a.kilnCalls : requests(a.flow),
        promptTokens: a.promptTokens,
        completionTokens: a.completionTokens,
        reasoningTokens: a.reasoningTokens,
        totalTokens: a.totalTokens,
        costUsd: formatUsd(usd(a.costUsd)),
        generationIds: a.generationIds,
        energyWhUpper: energyWhUpper(a.latencyMsSum),
    }));
    const blockedRequests = requests("rule_block");
    if (blockedRequests > 0)
        rows.push({ flow: "rule_block", kilnCalls: 0, requests: blockedRequests, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: "0", generationIds: [], energyWhUpper: 0 });

    const kilnRows = rows.filter((r) => r.flow !== "rule_block");
    const sum = (k: "kilnCalls" | "promptTokens" | "completionTokens" | "totalTokens" | "energyWhUpper") => kilnRows.reduce((s, r) => s + r[k], 0);
    const judge = kilnRows.find((r) => r.flow === "intent_judge" && r.kilnCalls > 0);

    return {
        provider,
        rows,
        totals: {
            kilnCalls: sum("kilnCalls"),
            promptTokens: sum("promptTokens"),
            completionTokens: sum("completionTokens"),
            reasoningTokens: kilnRows.reduce<number | null>((s, r) => addNullable(s, r.reasoningTokens), null),
            totalTokens: sum("totalTokens"),
            costUsd: formatUsd(kilnRows.reduce((s, r) => s + usd(r.costUsd), 0)),
            energyWhUpper: sum("energyWhUpper"),
        },
        savings: {
            ruleBlockedRequests: blockedRequests,
            avoidedTokensEstimate: judge ? Math.round((blockedRequests * judge.totalTokens) / judge.kilnCalls) : 0,
            avoidedEnergyWhUpper: judge ? (blockedRequests * judge.energyWhUpper) / judge.kilnCalls : 0,
        },
        energy: {
            formula: ENERGY_ASSUMPTIONS.formula,
            assumptions: (["cards", "cardPowerW"] as const).map((name) => ({ name, ...ENERGY_ASSUMPTIONS[name] })),
            disclaimer: ENERGY_ASSUMPTIONS.disclaimer,
        },
    };
}
