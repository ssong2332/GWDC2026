import { describe, expect, it } from "vitest";
import { replayPolicy, type ReplayEvent } from "@/core/domain/replay";

// Check R of the third-party verifier (Architecture 5): replay PolicySet → SpendExecuted in chain order and
// flag executions outside (allowed merchant ∧ cumulative spent ≤ budget ∧ before expiry ∧ (≤ threshold ∨ Approved)).

const DAISO = "0x000000000000000000000000000000000000dA15";
const COUPANG = "0x000000000000000000000000000000000000C0A9";
const GMARKET = "0x0000000000000000000000000000000000009a4E";
const EXPIRES = 2_000_000_000;
const rid = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
let seq = 0;

function e(name: string, args: Record<string, unknown>, at: { block?: number; ts?: number } = {}): ReplayEvent {
    seq++;
    return { name, txHash: `0x${seq.toString(16).padStart(64, "0")}`, logIndex: 0, blockNumber: BigInt(at.block ?? seq), blockTimestamp: at.ts ?? 1_900_000_000, args };
}
const policy = (over: Record<string, unknown> = {}, at = {}) =>
    e("PolicySet", { policyVersion: 1n, budget: 200_000n, approvalThreshold: 50_000n, expiresAt: BigInt(EXPIRES), merchants: [DAISO, COUPANG], ...over }, at);
const exec = (n: number, merchant: string, amount: bigint, at = {}, viaApproval = false) =>
    e("SpendExecuted", { requestId: rid(n), merchant, amount, fee: amount / 100n, policyVersion: 1n, viaApproval }, at);

describe("replayPolicy", () => {
    it("the demo sequence is within policy (execute, approved large spend, blocked/pending ignored)", () => {
        const events = [
            policy(),
            exec(1, DAISO, 30_000n),
            e("SpendBlocked", { requestId: rid(2), merchant: GMARKET, amount: 20_000n, reason: 6 }),
            e("SpendPending", { requestId: rid(3), merchant: COUPANG, amount: 60_000n, flags: 1 }),
            e("Approved", { requestId: rid(3) }),
            exec(3, COUPANG, 60_000n, {}, true),
        ];
        expect(replayPolicy(events)).toEqual([]);
    });

    it("cumulative spent exactly equal to the budget is allowed (boundary); one won more is OVER_BUDGET", () => {
        const exact = [policy({ budget: 20_200n, approvalThreshold: 20_200n }), exec(1, DAISO, 10_000n), exec(2, DAISO, 10_000n)];
        expect(replayPolicy(exact)).toEqual([]);
        const over = [policy({ budget: 20_199n, approvalThreshold: 20_199n }), exec(1, DAISO, 10_000n), exec(2, DAISO, 10_000n)];
        expect(replayPolicy(over)).toEqual([expect.objectContaining({ requestId: rid(2), problems: ["OVER_BUDGET"] })]);
    });

    it("a new PolicySet resets spent (setPolicy semantics)", () => {
        const events = [policy({ budget: 10_100n, approvalThreshold: 10_100n }), exec(1, DAISO, 10_000n), policy({ policyVersion: 2n, budget: 10_100n, approvalThreshold: 10_100n }), exec(2, DAISO, 10_000n)];
        expect(replayPolicy(events)).toEqual([]);
    });

    it.each<[string, ReplayEvent[], string[]]>([
        ["merchant not in the policy", [policy(), exec(1, GMARKET, 1_000n)], ["MERCHANT_NOT_ALLOWED"]],
        ["executed at expiresAt (expired)", [policy(), exec(1, DAISO, 1_000n, { ts: EXPIRES })], ["EXPIRED"]],
        ["above threshold without an Approved", [policy(), exec(1, DAISO, 50_001n)], ["APPROVAL_MISSING"]],
        ["an execution before any PolicySet", [exec(1, DAISO, 1_000n)], ["NO_POLICY"]],
        ["several rules at once", [policy(), exec(1, GMARKET, 60_000n, { ts: EXPIRES + 1 })], ["MERCHANT_NOT_ALLOWED", "EXPIRED", "APPROVAL_MISSING"]],
    ])("flags %s", (_label, events, problems) => {
        expect(replayPolicy(events)).toEqual([expect.objectContaining({ requestId: rid(1), problems })]);
    });

    it("threshold exactly equal is fine without approval; an Approved for another request does not count", () => {
        expect(replayPolicy([policy(), exec(1, DAISO, 50_000n)])).toEqual([]);
        const events = [policy(), e("Approved", { requestId: rid(9) }), exec(1, DAISO, 60_000n)];
        expect(replayPolicy(events)[0].problems).toEqual(["APPROVAL_MISSING"]);
    });

    it("replays in (blockNumber, logIndex) order regardless of input order", () => {
        const p = policy({ budget: 10_100n, approvalThreshold: 10_100n }, { block: 1 });
        const x = exec(1, DAISO, 10_000n, { block: 2 });
        expect(replayPolicy([x, p])).toEqual([]);
    });

    it("matches merchants case-insensitively and accepts decimal-string amounts", () => {
        const events = [policy({ merchants: [DAISO.toLowerCase()] }), e("SpendExecuted", { requestId: rid(1), merchant: DAISO.toUpperCase().replace("0X", "0x"), amount: "1000", fee: "10" })];
        expect(replayPolicy(events)).toEqual([]);
    });
});
