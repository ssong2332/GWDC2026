import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeKilnClient, queueHandler, type FakeReply } from "@/adapters/kiln/fakeKilnClient";
import { createKilnCallRepo } from "@/adapters/db/kilnCallRepo";
import { openDatabase } from "@/adapters/db/sqlite";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import { AppError } from "@/core/errors";
import { parsePolicy } from "@/core/usecases/parsePolicy";

const VAULT = "0x00000000000000000000000000000000000000AA" as const;
const DEMO = "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐";
const DEMO_ARGS = {
    total_budget_krw: 200000,
    approval_threshold_krw: 50000,
    allowed_merchant_ids: ["daiso", "coupang"],
    unrecognized_merchants: [],
    expires_on: null,
    purpose: "Supplies for the student club event",
};
const policyCall = (args: unknown, extra: Partial<FakeReply> = {}): FakeReply => ({
    toolCall: { name: "submit_spending_policy", arguments: args },
    usage: { promptTokens: 920, completionTokens: 310, reasoningTokens: 200, costUsd: "0.00041" },
    generationId: "gen-parse-1",
    ...extra,
});

let db: Database.Database;
beforeEach(() => {
    db = openDatabase(":memory:");
});
afterEach(() => db.close());

function run(replies: FakeReply[], delegationText = DEMO, now = new Date("2026-09-28T03:00:00Z")) {
    const kiln = new FakeKilnClient(queueHandler(replies));
    const deps = {
        kiln,
        kilnCalls: createKilnCallRepo(db),
        merchants: MERCHANT_REGISTRY,
        clock: { now: () => now },
        chainId: 31337,
        vault: VAULT,
    };
    return { kiln, result: parsePolicy(deps, { delegationText }) };
}
const rows = () => db.prepare("SELECT * FROM kiln_calls").all() as Record<string, unknown>[];

describe("parsePolicy (F-01) — fake Kiln + SQLite", () => {
    it("F-01 ①: validated demo policy with the three values, and the call's usage + Generation-Id stored under flow policy_parse", async () => {
        const { result } = run([policyCall(DEMO_ARGS)]);
        const r = await result;
        expect(r).toMatchObject({
            ok: true,
            candidate: { budget: 200_000n, approvalThreshold: 50_000n, merchantIds: ["daiso", "coupang"], expiresOn: null },
            warnings: [],
        });
        const [row] = rows();
        expect(row).toMatchObject({
            call_id: r.parseCallId,
            flow: "policy_parse",
            provider: "fake",
            status: "tool_call",
            prompt_tokens: 920,
            completion_tokens: 310,
            reasoning_tokens: 200,
            total_tokens: 1230,
            cost_usd: "0.00041",
            generation_id: "gen-parse-1",
            chain_id: 31337,
            vault: VAULT,
            request_id: null,
            raw_arguments: JSON.stringify(DEMO_ARGS),
        });
    });

    it("sends today's date in Asia/Seoul and the registry to Kiln", async () => {
        const { kiln, result } = run([policyCall(DEMO_ARGS)], DEMO, new Date("2026-09-28T15:30:00Z"));
        await result;
        expect(kiln.calls).toEqual([
            { kind: "policy_parse", input: { delegationText: DEMO, todayKst: "2026-09-29", merchants: MERCHANT_REGISTRY } },
        ]);
    });

    it("F-01 ④: a deadline returned by Kiln is kept in the candidate", async () => {
        const r = await run([policyCall({ ...DEMO_ARGS, expires_on: "2026-10-05" })], `${DEMO}, 10월 5일까지`).result;
        expect(r.ok && r.candidate.expiresOn).toBe("2026-10-05");
    });

    it("F-01 ⑤: no deadline in the sentence → expiresOn null (the owner fills it in later)", async () => {
        const r = await run([policyCall(DEMO_ARGS)]).result;
        expect(r.ok && r.candidate.expiresOn).toBeNull();
    });

    it("F-01 ②: no tool call → no policy, code NO_TOOL_CALL, and the call is still recorded", async () => {
        const r = await run([{ content: "<think>..</think>I cannot do that." }]).result;
        expect(r).toMatchObject({ ok: false, code: "NO_TOOL_CALL" });
        expect(r.ok ? null : r.parseCallId).toBe(rows()[0].call_id);
        expect(rows()[0]).toMatchObject({ status: "no_tool_call", raw_content: "I cannot do that.", raw_arguments: null });
    });

    it("F-01 ②: schema violations, broken JSON, unknown merchants and a wrong function are rejected with their codes", async () => {
        const cases: [FakeReply, string][] = [
            [policyCall({ ...DEMO_ARGS, approval_threshold_krw: 300000 }), "SCHEMA_INVALID"],
            [policyCall("{broken"), "INVALID_ARGS"],
            [policyCall({ ...DEMO_ARGS, allowed_merchant_ids: ["daiso", "emart"] }), "UNKNOWN_MERCHANT"],
            [{ toolCall: { name: "submit_intent_judgment", arguments: DEMO_ARGS } }, "INVALID_ARGS"],
        ];
        for (const [reply, code] of cases) {
            const r = await run([reply]).result;
            expect(r, code).toMatchObject({ ok: false, code });
            expect(r.ok ? "" : r.message, code).not.toBe("");
        }
        expect(rows()).toHaveLength(4);
    });

    it("maps a Kiln 402 to KILN_CREDIT_EXHAUSTED (PRD N-05) and records the failed call", async () => {
        const r = await run([{ httpError: 402 }]).result;
        expect(r).toMatchObject({ ok: false, code: "KILN_CREDIT_EXHAUSTED" });
        expect(rows()[0]).toMatchObject({ status: "http_error", http_status: 402, error_code: "KILN_CREDIT_EXHAUSTED", total_tokens: 0 });
    });

    it("accepts a 500-character sentence and rejects an empty or 501-character one before calling Kiln", async () => {
        expect((await run([policyCall(DEMO_ARGS)], "가".repeat(500)).result).ok).toBe(true);
        for (const text of ["", "   ", "가".repeat(501)]) {
            const { kiln, result } = run([policyCall(DEMO_ARGS)], text);
            await expect(result).rejects.toSatisfy((e) => e instanceof AppError && e.code === "VALIDATION_FAILED");
            expect(kiln.calls).toHaveLength(0);
        }
    });
});
