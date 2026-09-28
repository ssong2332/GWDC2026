import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENERGY_ASSUMPTIONS } from "@/config/constants";
import {
    aggregateCalls,
    composeEfficiencyReport,
    energyWhUpper,
    requestFlowCounts,
    type FlowAggregate,
    type UsageCall,
} from "@/core/domain/efficiency";
import { parseEvidenceExport } from "@/core/usecases/verifyTx";

// F-14: per-flow Kiln usage, rule-block rows at 0 tokens, energy upper bound (D-20: latency_s × 2 cards × 180 W ÷ 3600).

let seq = 0;
function call(over: Partial<UsageCall> = {}): UsageCall {
    seq++;
    return {
        flow: "intent_judge",
        provider: "kiln",
        promptTokens: 300,
        completionTokens: 200,
        reasoningTokens: 150,
        totalTokens: 500,
        costUsd: "0.0001",
        latencyMs: 4000,
        generationId: `gen-${seq}`,
        createdAt: `2026-09-28T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
        ...over,
    };
}

describe("energyWhUpper (D-20)", () => {
    it("8,086 ms → 8.086 s × 2 × 180 W ÷ 3600 = 0.8086 Wh", () => {
        expect(energyWhUpper(8086)).toBeCloseTo(0.8086, 10);
    });
    it("0 ms → 0 Wh (rule-block flow)", () => {
        expect(energyWhUpper(0)).toBe(0);
    });
    it("uses the documented assumptions (2 cards, 180 W)", () => {
        expect(ENERGY_ASSUMPTIONS.cards.value).toBe(2);
        expect(ENERGY_ASSUMPTIONS.cardPowerW.value).toBe(180);
        expect(energyWhUpper(3_600_000)).toBe(360);
    });
    it("negative or non-finite latency → throws (a corrupted record must not look like savings)", () => {
        expect(() => energyWhUpper(-1)).toThrow();
        expect(() => energyWhUpper(Number.NaN)).toThrow();
    });
});

describe("aggregateCalls (JS mirror of KilnCallRepo.aggregateByFlow)", () => {
    it("groups by flow for one provider: count, token sums, cost total, latency sum, generation ids in time order", () => {
        const rows = aggregateCalls(
            [
                call({ flow: "policy_parse", totalTokens: 1075, promptTokens: 624, completionTokens: 451, reasoningTokens: 367, costUsd: "0.00017604", latencyMs: 8086, generationId: "p1" }),
                call({ generationId: "j2", createdAt: "2026-09-28T00:00:09.000Z" }),
                call({ generationId: "j1", createdAt: "2026-09-28T00:00:08.000Z", costUsd: "0.0002" }),
                call({ provider: "fake", generationId: "x" }),
            ],
            "kiln",
        );
        expect(rows).toEqual([
            { flow: "policy_parse", kilnCalls: 1, promptTokens: 624, completionTokens: 451, totalTokens: 1075, reasoningTokens: 367, costUsd: "0.00017604", latencyMsSum: 8086, generationIds: ["p1"] },
            { flow: "intent_judge", kilnCalls: 2, promptTokens: 600, completionTokens: 400, totalTokens: 1000, reasoningTokens: 300, costUsd: "0.0003", latencyMsSum: 8000, generationIds: ["j1", "j2"] },
        ]);
    });
    it("no calls → no rows", () => {
        expect(aggregateCalls([], "kiln")).toEqual([]);
    });
    it("reasoning tokens all null → null (SQL SUM semantics); some null → sum of the rest; null cost/generation id skipped", () => {
        const allNull = aggregateCalls([call({ reasoningTokens: null }), call({ reasoningTokens: null, costUsd: null, generationId: null })], "kiln");
        expect(allNull[0]).toMatchObject({ reasoningTokens: null, costUsd: "0.0001", kilnCalls: 2 });
        expect(allNull[0].generationIds).toHaveLength(1);
        expect(aggregateCalls([call({ reasoningTokens: null }), call({ reasoningTokens: 7 })], "kiln")[0].reasoningTokens).toBe(7);
    });
});

describe("requestFlowCounts (spend_request evidence → rule_block / intent_judge)", () => {
    const req = (verdict: "pass" | "block") => ({ kind: "spend_request", package: { precheck: { verdict } } });
    it("pre-check block → rule_block, pass → intent_judge, other kinds ignored", () => {
        expect(requestFlowCounts([req("block"), req("pass"), req("pass"), { kind: "policy_set", package: {} }])).toEqual([
            { flow: "intent_judge", n: 2 },
            { flow: "rule_block", n: 1 },
        ]);
    });
    it("no spend requests → empty", () => {
        expect(requestFlowCounts([])).toEqual([]);
    });
});

const agg = (over: Partial<FlowAggregate>): FlowAggregate => ({
    flow: "intent_judge",
    kilnCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: null,
    costUsd: "0",
    latencyMsSum: 0,
    generationIds: [],
    ...over,
});

describe("composeEfficiencyReport (F-14 ①②③)", () => {
    const parse = agg({ flow: "policy_parse", kilnCalls: 1, promptTokens: 624, completionTokens: 451, totalTokens: 1075, reasoningTokens: 367, costUsd: "0.00017604", latencyMsSum: 8086, generationIds: ["p1"] });
    const judge = agg({ kilnCalls: 2, promptTokens: 700, completionTokens: 500, totalTokens: 1200, reasoningTokens: 400, costUsd: "0.0002", latencyMsSum: 9000, generationIds: ["j1", "j2"] });

    it("rows per flow, rule_block row with 0 tokens / 0 Kiln calls, totals = sum of Kiln rows, savings from the judge average", () => {
        const r = composeEfficiencyReport("kiln", [parse, judge], [
            { flow: "intent_judge", n: 2 },
            { flow: "rule_block", n: 3 },
        ]);
        expect(r.provider).toBe("kiln");
        expect(r.rows.map((x) => [x.flow, x.kilnCalls, x.requests, x.totalTokens])).toEqual([
            ["policy_parse", 1, 1, 1075],
            ["intent_judge", 2, 2, 1200],
            ["rule_block", 0, 3, 0],
        ]);
        expect(r.rows[2]).toMatchObject({ promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: "0", generationIds: [], energyWhUpper: 0 });
        expect(r.rows[0].energyWhUpper).toBeCloseTo(0.8086, 10);
        expect(r.rows[1].energyWhUpper).toBeCloseTo(0.9, 10);
        expect(r.totals).toMatchObject({ kilnCalls: 3, promptTokens: 1324, completionTokens: 951, reasoningTokens: 767, totalTokens: 2275, costUsd: "0.00037604" });
        expect(r.totals.energyWhUpper).toBeCloseTo(1.7086, 10);
        expect(r.savings.ruleBlockedRequests).toBe(3);
        expect(r.savings.avoidedTokensEstimate).toBe(1800); // 3 × (1200 / 2)
        expect(r.savings.avoidedEnergyWhUpper).toBeCloseTo(1.35, 10); // 3 × (0.9 / 2)
        expect(r.energy.formula).toContain("3600");
        expect(r.energy.disclaimer).toMatch(/not measured/i);
        expect(r.energy.assumptions.map((a) => [a.name, a.value, a.unit])).toEqual([
            ["cards", 2, "cards"],
            ["cardPowerW", 180, "W"],
        ]);
        expect(r.energy.assumptions.every((a) => a.source.length > 0)).toBe(true);
    });
    it("no data → 0 rows, zero totals, reasoning null, no savings", () => {
        const r = composeEfficiencyReport("fake", [], []);
        expect(r.rows).toEqual([]);
        expect(r.totals).toEqual({ kilnCalls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: null, totalTokens: 0, costUsd: "0", energyWhUpper: 0 });
        expect(r.savings).toEqual({ ruleBlockedRequests: 0, avoidedTokensEstimate: 0, avoidedEnergyWhUpper: 0 });
    });
    it("rule blocks without any judge call → savings 0 (no average to extrapolate from)", () => {
        const r = composeEfficiencyReport("kiln", [parse], [{ flow: "rule_block", n: 2 }]);
        expect(r.savings).toEqual({ ruleBlockedRequests: 2, avoidedTokensEstimate: 0, avoidedEnergyWhUpper: 0 });
        expect(r.totals.reasoningTokens).toBe(367);
    });
    it("unknown request flow or unparsable cost → throws", () => {
        expect(() => composeEfficiencyReport("kiln", [], [{ flow: "mystery", n: 1 }])).toThrow();
        expect(() => composeEfficiencyReport("kiln", [agg({ kilnCalls: 1, costUsd: "abc" })], [])).toThrow();
    });
});

describe("Base Sepolia evidence file (2026-09-28 run, real Kiln)", () => {
    it("policy_parse 1 call / 1,075 tokens, intent_judge 7 calls, rule_block 3 requests at 0 tokens", () => {
        const file = parseEvidenceExport(JSON.parse(fs.readFileSync(path.resolve("evidence/base-sepolia/evidence.json"), "utf8")));
        const calls = file.kilnCalls as UsageCall[];
        const r = composeEfficiencyReport("kiln", aggregateCalls(calls, "kiln"), requestFlowCounts(file.records));
        expect(r.rows.map((x) => [x.flow, x.kilnCalls, x.requests, x.totalTokens])).toEqual([
            ["policy_parse", 1, 1, 1075],
            ["intent_judge", 7, 7, 661 + 607 + 599 + 585 + 574 + 568 + 616],
            ["rule_block", 0, 3, 0],
        ]);
        expect(r.totals.kilnCalls).toBe(8);
        expect(r.totals.totalTokens).toBe(calls.reduce((s, c) => s + c.totalTokens, 0));
        expect(r.rows[1].generationIds).toHaveLength(7);
    });
});
