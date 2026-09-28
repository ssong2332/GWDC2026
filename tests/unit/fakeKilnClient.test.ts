import { describe, expect, it } from "vitest";
import { FakeKilnClient, defaultFakeHandler, queueHandler } from "@/adapters/kiln/fakeKilnClient";
import { MERCHANT_REGISTRY } from "@/config/merchants";

const JUDGE = {
    purpose: "Event supplies",
    delegationText: "행사비 20만 원을 맡길게",
    merchantName: "Daiso",
    amount: 15_000n,
    itemDescription: "Personal gaming mouse",
};

describe("FakeKilnClient", () => {
    it("records provider 'fake', the flow label, usage and generation id from the scripted reply", async () => {
        const kiln = new FakeKilnClient(
            queueHandler([
                {
                    toolCall: { name: "submit_intent_judgment", arguments: { fits_purpose: true, reason: "ok" } },
                    usage: { promptTokens: 300, completionTokens: 90, reasoningTokens: 60, costUsd: "0.0002" },
                    generationId: "fake-gen-1",
                },
            ]),
        );
        const r = await kiln.judgeIntent(JUDGE);
        expect(r.outcome).toEqual({
            kind: "tool_call",
            functionName: "submit_intent_judgment",
            rawArguments: '{"fits_purpose":true,"reason":"ok"}',
        });
        expect(r.record).toMatchObject({
            flow: "intent_judge",
            provider: "fake",
            httpStatus: 200,
            attempts: 1,
            promptTokens: 300,
            completionTokens: 90,
            reasoningTokens: 60,
            totalTokens: 390,
            costUsd: "0.0002",
            generationId: "fake-gen-1",
        });
        expect(kiln.calls).toEqual([{ kind: "intent_judge", input: JUDGE }]);
    });

    it("scripts no-tool-call and HTTP error replies", async () => {
        const kiln = new FakeKilnClient(queueHandler([{ content: "<think>x</think>free text" }, { httpError: 402 }]));
        expect((await kiln.judgeIntent(JUDGE)).outcome).toEqual({ kind: "no_tool_call", content: "free text" });
        const failed = await kiln.judgeIntent(JUDGE);
        expect(failed.outcome).toEqual({ kind: "http_error", status: 402, code: "KILN_CREDIT_EXHAUSTED" });
        expect(failed.record).toMatchObject({ httpStatus: 402, totalTokens: 0 });
    });

    it("fails loudly when a test did not queue enough replies", async () => {
        const kiln = new FakeKilnClient(queueHandler([]));
        await expect(kiln.judgeIntent(JUDGE)).rejects.toThrow(/no scripted reply/);
    });

    it("default handler: judge is mismatch iff the item matches /personal|gaming|개인/i", async () => {
        const kiln = new FakeKilnClient(defaultFakeHandler);
        const bad = await kiln.judgeIntent(JUDGE);
        const good = await kiln.judgeIntent({ ...JUDGE, itemDescription: "Balloons and table decorations" });
        const argsOf = (r: typeof bad) => (r.outcome.kind === "tool_call" ? JSON.parse(r.outcome.rawArguments) : null);
        expect(argsOf(bad).fits_purpose).toBe(false);
        expect(argsOf(good).fits_purpose).toBe(true);
    });

    it("default handler: parses the demo sentence to 200,000 / 50,000 / daiso+coupang / no deadline", async () => {
        const kiln = new FakeKilnClient(defaultFakeHandler);
        const r = await kiln.parsePolicy({
            delegationText: "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐",
            todayKst: "2026-09-28",
            merchants: MERCHANT_REGISTRY,
        });
        expect(r.outcome.kind).toBe("tool_call");
        if (r.outcome.kind !== "tool_call") return;
        expect(JSON.parse(r.outcome.rawArguments)).toMatchObject({
            total_budget_krw: 200000,
            approval_threshold_krw: 50000,
            allowed_merchant_ids: ["daiso", "coupang"],
            expires_on: null,
        });
    });
});
