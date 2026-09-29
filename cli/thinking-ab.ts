import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { OpenAiKilnClient } from "@/adapters/kiln/openaiKilnClient";
import { errorCodeFor } from "@/adapters/kiln/retryPolicy";
import type { JudgeInput, ThinkingMode } from "@/adapters/kiln/types";
import { parseServerEnv } from "@/config/env";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import { interpretIntentOutcome } from "@/core/domain/intent";
import { kstDate } from "@/core/domain/policy";
import type { PolicyCandidate } from "@/core/domain/types";
import { AppError } from "@/core/errors";
import type { KilnCallRepo, KilnClient } from "@/core/ports";
import { parsePolicy } from "@/core/usecases/parsePolicy";
import { loadEnvFiles } from "./_env";

// T-11 / F-16: thinking mode A/B on the intent_judge flow (PRD OQ #17 — same request × 3 modes × 3 runs = 9 Kiln calls).
//   npm run measure:thinking            (real Kiln — KILN_API_KEY from .env, loaded at runtime by this process)
// Hard cap: at most 9 real HTTP requests. Any failure (non-2xx or network error) halts the run — no retries,
// no extra calls to make up the count. Only the mode rows, token counts, latency, Generation-Id and the judgment
// are written; the API key, base URL and env values never go to the file, stdout or the log lines.

export const THINKING_MODES: readonly ThinkingMode[] = ["default", "kwargs_off", "no_think"];
export const RUNS_PER_MODE = 3;
export const AB_SCHEMA = "thinking-ab/v1";

const daiso = MERCHANT_REGISTRY.find((m) => m.id === "daiso");
if (!daiso) throw new Error("merchant registry has no daiso entry");

/** The demo scenario's representative purchase (e2e step 2 — executed on Base Sepolia with this exact judge input). */
export const AB_JUDGE_INPUT: JudgeInput = {
    purpose: "Event expenses",
    delegationText: "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐",
    merchantName: daiso.displayName,
    amount: 30_000n,
    itemDescription: "Balloons and table decorations for the welcome party",
};

export type AbSample = {
    mode: ThinkingMode;
    run: number;
    httpStatus: number | null;
    attempts: number;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number | null;
    totalTokens: number;
    cachedTokens: number | null;
    costUsd: string | null;
    finishReason: string | null;
    generationId: string | null;
    /** interpretIntentOutcome status: match | mismatch | invalid_output | error */
    judgment: string;
    reason: string;
};

export type ModeSummary = {
    mode: ThinkingMode;
    runs: number;
    /** samples with a 2xx response — only these enter the averages */
    ok: number;
    avgPromptTokens: number | null;
    avgCompletionTokens: number | null;
    avgReasoningTokens: number | null;
    avgTotalTokens: number | null;
    avgLatencyMs: number | null;
    judgments: string[];
    /** % reduction vs the default mode's average (negative = increase); null for the default row itself */
    reasoningSavingsPct: number | null;
    completionSavingsPct: number | null;
    totalSavingsPct: number | null;
    latencySavingsPct: number | null;
};

export type AbSummary = { modes: ModeSummary[]; judgmentsAgree: boolean };

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Reduction of `value` vs `base` in %, rounded to 0.1. null when either side is missing or base is 0. */
export function savingsPct(base: number | null, value: number | null): number | null {
    if (base === null || value === null || base === 0) return null;
    return round1(((base - value) / base) * 100);
}

const isCount = (n: number) => Number.isInteger(n) && n >= 0;

function assertSample(s: AbSample): void {
    if (!THINKING_MODES.includes(s.mode)) throw new RangeError(`unknown thinking mode: ${String(s.mode)}`);
    for (const [k, v] of [
        ["promptTokens", s.promptTokens],
        ["completionTokens", s.completionTokens],
        ["totalTokens", s.totalTokens],
        ["reasoningTokens", s.reasoningTokens ?? 0],
    ] as const)
        if (!isCount(v)) throw new RangeError(`${k} must be a non-negative integer, got ${v}`);
    if (!(Number.isFinite(s.latencyMs) && s.latencyMs >= 0)) throw new RangeError(`latencyMs must be >= 0, got ${s.latencyMs}`);
}

const isOk = (s: AbSample) => s.httpStatus !== null && s.httpStatus >= 200 && s.httpStatus < 300;

function avg(values: number[]): number | null {
    return values.length === 0 ? null : round1(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Per-mode averages (2xx samples only), savings vs default, and whether every answered judgment is the same. */
export function summarizeAb(samples: AbSample[]): AbSummary {
    if (samples.length === 0) throw new RangeError("no samples to summarize");
    samples.forEach(assertSample);

    const rows = THINKING_MODES.filter((m) => samples.some((s) => s.mode === m)).map((mode) => {
        const all = samples.filter((s) => s.mode === mode);
        const ok = all.filter(isOk);
        const reasoning = ok.map((s) => s.reasoningTokens).filter((v): v is number => v !== null);
        return {
            mode,
            runs: all.length,
            ok: ok.length,
            avgPromptTokens: avg(ok.map((s) => s.promptTokens)),
            avgCompletionTokens: avg(ok.map((s) => s.completionTokens)),
            avgReasoningTokens: avg(reasoning),
            avgTotalTokens: avg(ok.map((s) => s.totalTokens)),
            avgLatencyMs: avg(ok.map((s) => s.latencyMs)),
            judgments: all.map((s) => s.judgment),
        };
    });
    const base = rows.find((r) => r.mode === "default");
    const vs = (pick: (r: (typeof rows)[number]) => number | null, r: (typeof rows)[number]) =>
        r.mode === "default" || !base ? null : savingsPct(pick(base), pick(r));
    const modes: ModeSummary[] = rows.map((r) => ({
        ...r,
        reasoningSavingsPct: vs((x) => x.avgReasoningTokens, r),
        completionSavingsPct: vs((x) => x.avgCompletionTokens, r),
        totalSavingsPct: vs((x) => x.avgTotalTokens, r),
        latencySavingsPct: vs((x) => x.avgLatencyMs, r),
    }));
    const answered = samples.filter(isOk).map((s) => s.judgment);
    return { modes, judgmentsAgree: answered.length > 0 && answered.every((j) => j === answered[0]) };
}

const cell = (n: number | null) => (n === null ? "-" : String(n));
const pct = (n: number | null, isBase: boolean) => (isBase ? "baseline" : n === null ? "-" : `${n}%`);

export function formatAbMarkdown(s: AbSummary): string {
    const head =
        "| mode | runs (ok) | avg prompt | avg completion | avg reasoning | avg total | avg latency (ms) | reasoning saved | completion saved | total saved | latency saved | judgments |";
    const rows = s.modes.map((m) => {
        const b = m.mode === "default";
        return `| ${m.mode} | ${m.runs} (${m.ok}) | ${cell(m.avgPromptTokens)} | ${cell(m.avgCompletionTokens)} | ${cell(m.avgReasoningTokens)} | ${cell(m.avgTotalTokens)} | ${cell(m.avgLatencyMs)} | ${pct(m.reasoningSavingsPct, b)} | ${pct(m.completionSavingsPct, b)} | ${pct(m.totalSavingsPct, b)} | ${pct(m.latencySavingsPct, b)} | ${m.judgments.join(", ")} |`;
    });
    return [
        head,
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
        ...rows,
        "",
        "Saved = reduction of the mode's average vs the default mode's average (negative = increase). Averages use 2xx responses only.",
        `Judgments agree across modes: ${s.judgmentsAgree ? "YES" : "NO"}`,
    ].join("\n");
}

/** status: the last non-2xx HTTP status, or 0 when there was no usable response (network error, unusable 2xx body). */
type Halt = { status: number; message: string };

/**
 * Wraps fetch with a hard cap on real HTTP requests. After the first non-2xx response or network error every later
 * request is refused before it reaches the network, so the Kiln client's own retries cannot add calls.
 * `refuseRetry()` is called when the client is about to retry: if nothing halted yet, the last 2xx response was
 * unusable (e.g. an unparseable body), so it halts with status 0 before the retry can reach the network.
 */
export function createRequestGuard(limit: number, inner: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
    let sent = 0;
    let halt: Halt | null = null;
    let lastStatus: number | null = null;
    const guarded = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (halt) throw new Error(`request guard halted after ${halt.message} — no further requests`);
        if (sent >= limit) throw new Error(`request budget of ${limit} exhausted — no further requests`);
        sent++;
        let res: Response;
        try {
            res = await inner(url, init);
        } catch (err) {
            halt = { status: 0, message: (err instanceof Error ? err.message : String(err)).split("\n")[0] };
            throw err;
        }
        lastStatus = res.status;
        if (res.status < 200 || res.status >= 300) halt = { status: res.status, message: `HTTP ${res.status}` };
        return res;
    };
    const refuseRetry = () => {
        halt ??= { status: 0, message: `HTTP ${lastStatus ?? "-"} with an unusable response body` };
    };
    return { fetch: guarded, sent: () => sent, halt: () => halt, refuseRetry };
}

export type Stopped = { mode: ThinkingMode; run: number; httpStatus: number; code: string; message: string };

export type MeasureOptions = {
    apiKey: string;
    baseURL: string;
    model: string;
    maxTokensJudge: number;
    outDir: string;
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
    log?: (line: string) => void;
};

export type MeasureResult = {
    filePath: string;
    summary: AbSummary | null;
    markdown: string;
    stopped: Stopped | null;
    httpRequests: number;
};

type JudgeResult = Awaited<ReturnType<KilnClient["judgeIntent"]>>;

type Guard = ReturnType<typeof createRequestGuard>;

/** One Kiln client per mode, all sending through the guard. `maxTokens` is used for both flows' max_tokens. */
function guardedClients(
    o: { apiKey: string; baseURL: string; model: string },
    guard: Guard,
    modes: readonly ThinkingMode[],
    maxTokens: number,
    now: () => Date,
): Map<ThinkingMode, OpenAiKilnClient> {
    const client = (mode: ThinkingMode) =>
        new OpenAiKilnClient({
            apiKey: o.apiKey,
            baseURL: o.baseURL,
            body: { model: o.model, maxTokensParse: maxTokens, maxTokensJudge: maxTokens, thinkingMode: mode },
            fetch: guard.fetch as typeof globalThis.fetch,
            // The client sleeps only before a retry: refuse it (halt) and skip the backoff wait — no retries in this run.
            sleep: () => {
                guard.refuseRetry();
                return Promise.resolve();
            },
            now,
        });
    return new Map(modes.map((m) => [m, client(m)] as const));
}

/**
 * The client's record of a failed call ends on its own refused retries (status 0, attempts up to maxAttempts), so a
 * halted call is rewritten from the guard: the halting status, its error code and the real requests sent.
 */
function withHalt(r: JudgeResult, halt: Halt | null, realRequests: number): JudgeResult {
    if (r.outcome.kind !== "http_error" || !halt) return r;
    return {
        record: { ...r.record, httpStatus: halt.status === 0 ? null : halt.status, attempts: realRequests },
        outcome: { kind: "http_error", status: halt.status, code: errorCodeFor(halt.status) },
    };
}

function toSample(mode: ThinkingMode, run: number, r: JudgeResult): AbSample {
    const j = interpretIntentOutcome(r.outcome, r.record.callId);
    return { ...usageOf(mode, run, r.record), judgment: j.status, reason: j.reason };
}

function usageOf(mode: ThinkingMode, run: number, rec: JudgeResult["record"]): Omit<AbSample, "judgment" | "reason"> {
    return {
        mode,
        run,
        httpStatus: rec.httpStatus,
        attempts: rec.attempts,
        latencyMs: rec.latencyMs,
        promptTokens: rec.promptTokens,
        completionTokens: rec.completionTokens,
        reasoningTokens: rec.reasoningTokens,
        totalTokens: rec.totalTokens,
        cachedTokens: rec.cachedTokens,
        costUsd: rec.costUsd,
        finishReason: rec.finishReason,
        generationId: rec.generationId,
    };
}

/**
 * The intent_judge loop shared by T-11 and T-18: round-robin over `modes` × RUNS_PER_MODE through one guard
 * (hard cap = modes × runs, the first failure halts, no retries). `logExtra` is prepended to each call's log line.
 */
async function runJudgeAb(
    o: MeasureOptions,
    modes: readonly ThinkingMode[],
    input: JudgeInput,
    logExtra: Record<string, unknown> = {},
): Promise<{ samples: AbSample[]; stopped: Stopped | null; startedAt: string; finishedAt: string; budget: number; sent: number }> {
    const now = o.now ?? (() => new Date());
    const log = o.log ?? ((line: string) => console.log(line));
    const logJson = (event: string, fields: Record<string, unknown>) =>
        log(JSON.stringify({ ts: now().toISOString(), level: "info", event, ...fields }));
    const budget = modes.length * RUNS_PER_MODE;
    const guard = createRequestGuard(budget, o.fetch ?? globalThis.fetch);
    const clients = guardedClients(o, guard, modes, o.maxTokensJudge, now);

    const startedAt = now().toISOString();
    const samples: AbSample[] = [];
    let stopped: Stopped | null = null;
    outer: for (let run = 1; run <= RUNS_PER_MODE; run++) {
        for (const mode of modes) {
            const sentBefore = guard.sent();
            const r = withHalt(await clients.get(mode)!.judgeIntent(input), guard.halt(), guard.sent() - sentBefore);
            const s = toSample(mode, run, r);
            samples.push(s);
            logJson("thinking_ab.call", {
                ...logExtra,
                mode,
                run,
                httpStatus: s.httpStatus,
                promptTokens: s.promptTokens,
                completionTokens: s.completionTokens,
                reasoningTokens: s.reasoningTokens,
                totalTokens: s.totalTokens,
                latencyMs: s.latencyMs,
                generationId: s.generationId,
                judgment: s.judgment,
            });
            if (r.outcome.kind === "http_error") {
                const h = guard.halt();
                stopped = { mode, run, httpStatus: h?.status ?? r.outcome.status, code: r.outcome.code ?? "KILN_ERROR", message: h?.message ?? "request failed" };
                break outer;
            }
        }
    }
    return { samples, stopped, startedAt, finishedAt: now().toISOString(), budget, sent: guard.sent() };
}

/** Runs the A/B (round-robin: run 1 = default, kwargs_off, no_think, then run 2, …), saves the raw JSON, returns the table. */
export async function measureThinkingAb(o: MeasureOptions): Promise<MeasureResult> {
    const { samples, stopped, startedAt, finishedAt, budget, sent } = await runJudgeAb(o, THINKING_MODES, AB_JUDGE_INPUT);

    const summary = samples.length > 0 ? summarizeAb(samples) : null;
    const markdown = summary ? formatAbMarkdown(summary) : "(no samples)";
    fs.mkdirSync(o.outDir, { recursive: true });
    const filePath = path.join(o.outDir, `thinking-ab-${startedAt.replace(/[:.]/g, "-")}.json`);
    const file = {
        schema: AB_SCHEMA,
        task: "T-11",
        flow: "intent_judge",
        model: o.model,
        maxTokensJudge: o.maxTokensJudge,
        modes: THINKING_MODES,
        runsPerMode: RUNS_PER_MODE,
        order: "round-robin (run 1: default, kwargs_off, no_think; then run 2, run 3)",
        httpRequestBudget: budget,
        httpRequestsSent: sent,
        retryPolicy: "none — the first failed request halts the run",
        startedAt,
        finishedAt,
        input: { ...AB_JUDGE_INPUT, amount: AB_JUDGE_INPUT.amount.toString() },
        stopped,
        samples,
        summary,
    };
    fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    return { filePath, summary, markdown, stopped, httpRequests: sent };
}

// ---- T-18 / F-16 ⑥: intent_judge "purpose mismatch" case — default vs no_think × 3 runs = 6 real requests ----
//   npm run measure:thinking -- --flow intent_judge --case mismatch
// Same guard (hard cap 6, the first failure halts, no retries). The input is the submitted Base Sepolia run's step 5
// (SpendPending flags 2 — the AI judged the purchase outside the purpose). Gate: no_think 3/3 "mismatch" = pass.
// Recorded only — the default thinking mode is not changed here.

export type JudgeCase = "fit" | "mismatch";

/** --case value → case. No value keeps the T-11 run (the purpose-fit purchase). */
export function parseCaseArg(v: string | undefined): JudgeCase {
    if (v === undefined || v === "fit") return "fit";
    if (v === "mismatch") return "mismatch";
    throw new RangeError(`unknown --case ${JSON.stringify(v)} (expected fit or mismatch)`);
}

export const MISMATCH_AB_MODES: readonly ThinkingMode[] = ["default", "no_think"];
export const MISMATCH_AB_SCHEMA = "thinking-ab-mismatch/v1";

/**
 * e2e step 5 (cli/e2e.ts — daiso, 15,000, "Personal gaming mouse") under the demo policy, exactly as judged on Base
 * Sepolia: evidence/base-sepolia/evidence.json requestId 0x35f42c26… (request + judgment "mismatch") and its policy_set
 * record (final.purpose, delegationText, merchant displayName).
 */
export const AB_MISMATCH_INPUT: JudgeInput = {
    purpose: "Event expenses",
    delegationText: AB_JUDGE_INPUT.delegationText,
    merchantName: daiso.displayName,
    amount: 15_000n,
    itemDescription: "Personal gaming mouse",
};

const MISMATCH_INPUT_SOURCE =
    "evidence/base-sepolia/evidence.json — spend_request requestId 0x35f42c26de1c33fdabed31a554fd64fc02c394f08af78f4e41d95de15e8543c3 (e2e step 5, SpendPending flags 2, judgment mismatch) + its policy_set record; cli/e2e.ts step 5";

export type MismatchGateResult = "pass" | "fail" | "undetermined";
export type MismatchGate = { result: MismatchGateResult; noThinkJudgments: string[]; defaultJudgments: string[]; rule: string };

const MISMATCH_GATE_RULE =
    "pass = no_think runs 1..3 all answered 2xx with judgment mismatch; fail = any no_think judgment match; undetermined = a no_think run missing, failed or undecidable (invalid_output/error). default is recorded, not gating. Recorded only.";

/** Gate for the mismatch case: only the no_think runs decide (a match anywhere in them is a fail). */
export function judgeMismatchGate(samples: AbSample[], runsPerMode: number = RUNS_PER_MODE): MismatchGate {
    if (samples.length === 0) throw new RangeError("no samples to gate");
    for (const s of samples)
        if (!MISMATCH_AB_MODES.includes(s.mode)) throw new RangeError(`unknown thinking mode for the mismatch case: ${String(s.mode)}`);
    const runsOf = (m: ThinkingMode) => samples.filter((s) => s.mode === m).sort((a, b) => a.run - b.run);
    const nt = runsOf("no_think");
    const noThinkJudgments = nt.map((s) => s.judgment);
    const defaultJudgments = runsOf("default").map((s) => s.judgment);
    const complete = nt.length === runsPerMode && nt.every((s, i) => s.run === i + 1);
    const result: MismatchGateResult = noThinkJudgments.includes("match")
        ? "fail"
        : complete && nt.every((s) => isOk(s) && s.judgment === "mismatch")
          ? "pass"
          : "undetermined";
    return { result, noThinkJudgments, defaultJudgments, rule: MISMATCH_GATE_RULE };
}

export type MismatchAbSample = AbSample & { agentReviewRequest: boolean };
export type MismatchMeasureResult = MeasureResult & { gate: MismatchGate };

/** Runs the mismatch-case A/B (round-robin: run 1 = default, no_think, then run 2, …), saves the raw JSON, returns table + gate. */
export async function measureMismatchAb(o: MeasureOptions): Promise<MismatchMeasureResult> {
    const { samples: raw, stopped, startedAt, finishedAt, budget, sent } = await runJudgeAb(o, MISMATCH_AB_MODES, AB_MISMATCH_INPUT, {
        flow: "intent_judge",
        case: "mismatch",
    });
    // Same rule as processSpendRequest: anything but "match" sets agentReviewRequest (→ SpendPending flag 2).
    const samples: MismatchAbSample[] = raw.map((s) => ({ ...s, agentReviewRequest: s.judgment !== "match" }));

    const summary = samples.length > 0 ? summarizeAb(samples) : null;
    const gate = samples.length > 0 ? judgeMismatchGate(samples) : { result: "undetermined" as const, noThinkJudgments: [], defaultJudgments: [], rule: MISMATCH_GATE_RULE };
    const markdown = [
        summary ? formatAbMarkdown(summary) : "(no samples)",
        "",
        `Gate: ${gate.result.toUpperCase()} — no_think: ${gate.noThinkJudgments.join(", ") || "-"} / default: ${gate.defaultJudgments.join(", ") || "-"}`,
        `Gate rule: ${gate.rule}`,
    ].join("\n");
    fs.mkdirSync(o.outDir, { recursive: true });
    const filePath = path.join(o.outDir, `thinking-ab-intent_judge-mismatch-${startedAt.replace(/[:.]/g, "-")}.json`);
    const file = {
        schema: MISMATCH_AB_SCHEMA,
        task: "T-18",
        flow: "intent_judge",
        case: "mismatch",
        model: o.model,
        maxTokensJudge: o.maxTokensJudge,
        modes: MISMATCH_AB_MODES,
        runsPerMode: RUNS_PER_MODE,
        order: "round-robin (run 1: default, no_think; then run 2, run 3)",
        httpRequestBudget: budget,
        httpRequestsSent: sent,
        retryPolicy: "none — the first failed request halts the run",
        startedAt,
        finishedAt,
        input: { ...AB_MISMATCH_INPUT, amount: AB_MISMATCH_INPUT.amount.toString() },
        inputSource: MISMATCH_INPUT_SOURCE,
        stopped,
        samples,
        summary,
        gate,
    };
    fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    return { filePath, summary, markdown, stopped, httpRequests: sent, gate };
}

// ---- T-14 / F-16 ④: policy_parse flow — default vs no_think × 3 runs = 6 real requests ----
//   npm run measure:thinking -- --flow policy_parse
// Same guard as above (hard cap 6, the first failure halts, no retries). Each run goes through the product's
// parsePolicy use case (same prompt, validation and error codes as step 1 of the demo) and records the extracted
// PolicyCandidate fields. Gate (PRD OQ #24, conservative default): any field that differs — free-text `purpose`
// and run-to-run variation inside one mode included — makes the gate "different"; the gate is only recorded.

export type AbFlow = "intent_judge" | "policy_parse";

/** --flow value → flow. No value keeps the T-11 intent_judge run. */
export function parseFlowArg(v: string | undefined): AbFlow {
    if (v === undefined || v === "intent_judge") return "intent_judge";
    if (v === "policy_parse") return "policy_parse";
    throw new RangeError(`unknown --flow ${JSON.stringify(v)} (expected intent_judge or policy_parse)`);
}

export const POLICY_AB_MODES: readonly ThinkingMode[] = ["default", "no_think"];
export const POLICY_AB_SCHEMA = "thinking-ab-policy/v1";

/** The demo scenario's delegation sentence (cli/e2e.ts step 1 — the same sentence the judge input quotes). */
export const AB_POLICY_INPUT = { delegationText: AB_JUDGE_INPUT.delegationText } as const;

/** PolicyCandidate (src/core/domain/types.ts) with bigints as decimal strings. */
export type PolicyFields = {
    budget: string;
    approvalThreshold: string;
    merchantIds: string[];
    expiresOn: string | null;
    purpose: string;
    unrecognizedMerchants: string[];
};

/** `judgment` holds the parse result: "ok" or the parsePolicy error code; `policy` is null unless it is "ok". */
export type PolicyAbSample = AbSample & { policy: PolicyFields | null; rawArguments: string | null };

export const POLICY_COMPARED_FIELDS = ["parseResult", "budget", "approvalThreshold", "merchantIds", "expiresOn", "purpose", "unrecognizedMerchants"] as const;
export type PolicyComparedField = (typeof POLICY_COMPARED_FIELDS)[number];

export type PolicyFieldRow = {
    field: PolicyComparedField;
    /** per mode, runs in ascending order; "-" when the run produced no policy */
    values: Record<string, string[]>;
    sameWithinMode: Record<string, boolean>;
    /** every mode produced the same set of distinct values */
    sameAcrossModes: boolean;
    /** every run of every mode produced the identical value */
    allSame: boolean;
};

export type PolicyGate = "same" | "different" | "undetermined";
export type PolicyComparison = { rows: PolicyFieldRow[]; gate: PolicyGate; differingFields: PolicyComparedField[] };

function fieldValue(s: PolicyAbSample, f: PolicyComparedField): string {
    if (f === "parseResult") return s.judgment;
    if (!s.policy) return "-";
    if (f === "budget" || f === "approvalThreshold") return s.policy[f];
    return JSON.stringify(s.policy[f]);
}

const allEqual = (xs: string[]) => xs.every((x) => x === xs[0]);
const distinct = (xs: string[]) => JSON.stringify([...new Set(xs)].sort());

/**
 * Field-by-field agreement of the extracted policies. Gate: "undetermined" when a run is missing, a request failed
 * (non-2xx / no response) or no run produced a policy; "same" when every field is identical in all runs of all
 * modes; otherwise "different".
 */
export function comparePolicyFields(samples: PolicyAbSample[], runsPerMode: number = RUNS_PER_MODE): PolicyComparison {
    if (samples.length === 0) throw new RangeError("no samples to compare");
    for (const s of samples)
        if (!POLICY_AB_MODES.includes(s.mode)) throw new RangeError(`unknown thinking mode for policy_parse: ${String(s.mode)}`);
    const byMode = new Map(POLICY_AB_MODES.map((m) => [m, samples.filter((s) => s.mode === m).sort((a, b) => a.run - b.run)] as const));

    const rows = POLICY_COMPARED_FIELDS.map((field): PolicyFieldRow => {
        const values = Object.fromEntries(POLICY_AB_MODES.map((m) => [m, byMode.get(m)!.map((s) => fieldValue(s, field))]));
        const perMode = POLICY_AB_MODES.map((m) => values[m]);
        return {
            field,
            values,
            sameWithinMode: Object.fromEntries(POLICY_AB_MODES.map((m) => [m, allEqual(values[m])])),
            sameAcrossModes: allEqual(perMode.map(distinct)),
            allSame: allEqual(perMode.flat()),
        };
    });
    const differingFields = rows.filter((r) => !r.allSame).map((r) => r.field);

    const complete = POLICY_AB_MODES.every((m) => {
        const runs = byMode.get(m)!.map((s) => s.run);
        return runs.length === runsPerMode && runs.every((r, i) => r === i + 1);
    });
    const undetermined = !complete || !samples.every(isOk) || !samples.some((s) => s.judgment === "ok");
    const gate: PolicyGate = undetermined ? "undetermined" : differingFields.length === 0 ? "same" : "different";
    return { rows, gate, differingFields };
}

const mdCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const yesNo = (b: boolean) => (b ? "YES" : "NO");

export function formatPolicyFieldTable(c: PolicyComparison): string {
    const modes = POLICY_AB_MODES;
    const head = `| field | ${modes.map((m) => `${m} (run 1 / 2 / 3)`).join(" | ")} | ${modes.map((m) => `same within ${m}`).join(" | ")} | same across modes | all same |`;
    const sep = `|---|${modes.map(() => "---|").join("")}${modes.map(() => ":---:|").join("")}:---:|:---:|`;
    const rows = c.rows.map(
        (r) =>
            `| ${r.field} | ${modes.map((m) => mdCell(r.values[m].join(" / "))).join(" | ")} | ${modes.map((m) => yesNo(r.sameWithinMode[m])).join(" | ")} | ${yesNo(r.sameAcrossModes)} | ${yesNo(r.allSame)} |`,
    );
    return [
        head,
        sep,
        ...rows,
        "",
        `Gate: ${c.gate.toUpperCase()}${c.differingFields.length ? ` (differing fields: ${c.differingFields.join(", ")})` : ""}`,
        "Gate rule (PRD OQ #24, conservative default): any field differing in any run — purpose wording and variation inside one mode included — is DIFFERENT; a missing or failed run is UNDETERMINED. Recorded only — the default mode is not changed here.",
    ].join("\n");
}

export type PolicyMeasureOptions = Omit<MeasureOptions, "maxTokensJudge"> & { maxTokensParse: number };
export type PolicyMeasureResult = MeasureResult & { comparison: PolicyComparison | null; fieldTable: string };

function toPolicyFields(c: PolicyCandidate): PolicyFields {
    return {
        budget: c.budget.toString(),
        approvalThreshold: c.approvalThreshold.toString(),
        merchantIds: c.merchantIds,
        expiresOn: c.expiresOn,
        purpose: c.purpose,
        unrecognizedMerchants: c.unrecognizedMerchants,
    };
}

/** Runs the policy_parse A/B (round-robin: run 1 = default, no_think, then run 2, …), saves the raw JSON, returns the tables. */
export async function measurePolicyAb(o: PolicyMeasureOptions): Promise<PolicyMeasureResult> {
    const now = o.now ?? (() => new Date());
    const log = o.log ?? ((line: string) => console.log(line));
    const logJson = (event: string, fields: Record<string, unknown>) =>
        log(JSON.stringify({ ts: now().toISOString(), level: "info", event, ...fields }));
    const budget = POLICY_AB_MODES.length * RUNS_PER_MODE;
    const guard = createRequestGuard(budget, o.fetch ?? globalThis.fetch);
    const clients = guardedClients(o, guard, POLICY_AB_MODES, o.maxTokensParse, now);

    const start = now();
    const startedAt = start.toISOString();
    // One fixed "today" for every run so expires_on inference sees the same date in all 6 requests.
    const clock = { now: () => start };
    const samples: PolicyAbSample[] = [];
    let stopped: Stopped | null = null;
    outer: for (let run = 1; run <= RUNS_PER_MODE; run++) {
        for (const mode of POLICY_AB_MODES) {
            const inner = clients.get(mode)!;
            let call: JudgeResult | null = null;
            const kiln: KilnClient = {
                parsePolicy: async (i) => {
                    const sentBefore = guard.sent();
                    call = withHalt(await inner.parsePolicy(i), guard.halt(), guard.sent() - sentBefore);
                    return call;
                },
                judgeIntent: () => Promise.reject(new Error("judgeIntent is not part of the policy_parse A/B")),
            };
            const noopRepo: KilnCallRepo = { insert: () => {}, findById: () => null, aggregateByFlow: () => [] };
            const parsed = await parsePolicy(
                { kiln, kilnCalls: noopRepo, merchants: MERCHANT_REGISTRY, clock, chainId: 0, vault: "0x0000000000000000000000000000000000000000" },
                { delegationText: AB_POLICY_INPUT.delegationText },
            );
            const r = call as JudgeResult | null;
            if (!r) throw new Error("parsePolicy returned without calling Kiln");
            const s: PolicyAbSample = {
                ...usageOf(mode, run, r.record),
                judgment: parsed.ok ? "ok" : parsed.code,
                reason: parsed.ok ? parsed.warnings.join("; ") : parsed.message,
                policy: parsed.ok ? toPolicyFields(parsed.candidate) : null,
                rawArguments: r.outcome.kind === "tool_call" ? r.outcome.rawArguments : null,
            };
            samples.push(s);
            logJson("thinking_ab.call", {
                flow: "policy_parse",
                mode,
                run,
                httpStatus: s.httpStatus,
                promptTokens: s.promptTokens,
                completionTokens: s.completionTokens,
                reasoningTokens: s.reasoningTokens,
                totalTokens: s.totalTokens,
                latencyMs: s.latencyMs,
                generationId: s.generationId,
                parseResult: s.judgment,
            });
            if (r.outcome.kind === "http_error") {
                const h = guard.halt();
                stopped = { mode, run, httpStatus: h?.status ?? r.outcome.status, code: r.outcome.code ?? "KILN_ERROR", message: h?.message ?? "request failed" };
                break outer;
            }
        }
    }
    const finishedAt = now().toISOString();

    const summary = samples.length > 0 ? summarizeAb(samples) : null;
    const markdown = summary ? formatAbMarkdown(summary) : "(no samples)";
    const comparison = samples.length > 0 ? comparePolicyFields(samples) : null;
    const fieldTable = comparison ? formatPolicyFieldTable(comparison) : "(no samples)";
    fs.mkdirSync(o.outDir, { recursive: true });
    const filePath = path.join(o.outDir, `thinking-ab-policy_parse-${startedAt.replace(/[:.]/g, "-")}.json`);
    const file = {
        schema: POLICY_AB_SCHEMA,
        task: "T-14",
        flow: "policy_parse",
        model: o.model,
        maxTokensParse: o.maxTokensParse,
        modes: POLICY_AB_MODES,
        runsPerMode: RUNS_PER_MODE,
        order: "round-robin (run 1: default, no_think; then run 2, run 3)",
        httpRequestBudget: budget,
        httpRequestsSent: guard.sent(),
        retryPolicy: "none — the first failed request halts the run",
        startedAt,
        finishedAt,
        todayKst: kstDate(start),
        input: { ...AB_POLICY_INPUT },
        gateRule:
            "PRD OQ #24 conservative default: any field differing in any run (purpose wording and variation inside one mode included) = different; missing/failed run = undetermined. Recorded only.",
        stopped,
        samples,
        summary,
        comparison,
    };
    fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    return { filePath, summary, markdown, stopped, httpRequests: guard.sent(), comparison, fieldTable };
}

async function main(): Promise<number> {
    const { values } = parseArgs({ options: { out: { type: "string" }, flow: { type: "string" }, case: { type: "string" } } });
    const flow = parseFlowArg(values.flow);
    const judgeCase = parseCaseArg(values.case);
    if (flow !== "intent_judge" && values.case !== undefined) throw new AppError("VALIDATION_FAILED", "--case applies to --flow intent_judge only");
    // Only .env (the Kiln variables live there, .env.example) — wallet keys in .env.cli are not needed here.
    loadEnvFiles({ files: [".env"] });
    const env = parseServerEnv({ ...process.env, KILN_MODE: "real" });
    if (!env.kiln.apiKey) throw new AppError("ENV_INVALID", "KILN_API_KEY is required");
    if (flow === "policy_parse") {
        const p = await measurePolicyAb({
            apiKey: env.kiln.apiKey,
            baseURL: env.kiln.baseUrl,
            model: env.kiln.model,
            maxTokensParse: env.kiln.maxTokensParse,
            outDir: path.resolve(values.out ?? "evidence/thinking-ab"),
        });
        console.log(`\nThinking mode A/B — policy_parse, model ${env.kiln.model}, ${p.httpRequests} HTTP requests (judgments column = parse result)`);
        console.log(p.markdown);
        console.log(`\nExtracted policy fields:`);
        console.log(p.fieldTable);
        console.log(`\nraw: ${path.relative(process.cwd(), p.filePath)}`);
        if (p.stopped) {
            console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "thinking_ab.stopped", ...p.stopped }));
            return 1;
        }
        return 0;
    }
    if (judgeCase === "mismatch") {
        const m = await measureMismatchAb({
            apiKey: env.kiln.apiKey,
            baseURL: env.kiln.baseUrl,
            model: env.kiln.model,
            maxTokensJudge: env.kiln.maxTokensJudge,
            outDir: path.resolve(values.out ?? "evidence/thinking-ab"),
        });
        console.log(`\nThinking mode A/B — intent_judge (mismatch case, e2e step 5), model ${env.kiln.model}, ${m.httpRequests} HTTP requests`);
        console.log(m.markdown);
        console.log(`\nraw: ${path.relative(process.cwd(), m.filePath)}`);
        if (m.stopped) {
            console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "thinking_ab.stopped", ...m.stopped }));
            return 1;
        }
        return 0;
    }
    const r = await measureThinkingAb({
        apiKey: env.kiln.apiKey,
        baseURL: env.kiln.baseUrl,
        model: env.kiln.model,
        maxTokensJudge: env.kiln.maxTokensJudge,
        outDir: path.resolve(values.out ?? "evidence/thinking-ab"),
    });
    console.log(`\nThinking mode A/B — intent_judge, model ${env.kiln.model}, ${r.httpRequests} HTTP requests`);
    console.log(r.markdown);
    console.log(`\nraw: ${path.relative(process.cwd(), r.filePath)}`);
    if (r.stopped) {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "thinking_ab.stopped", ...r.stopped }));
        return 1;
    }
    return 0;
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
    main().then(
        (code) => {
            process.exitCode = code;
        },
        (err: unknown) => {
            const code = err instanceof AppError ? err.code : "INTERNAL";
            const message = (err instanceof Error ? err.message : String(err)).split("\n")[0];
            console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "thinking_ab.failed", code, message }));
            process.exitCode = 1;
        },
    );
}
