import { describe, expect, it } from "vitest";
import { evaluatePrecheck, remainingBudget } from "@/core/domain/precheck";
import { BlockReason } from "@/core/domain/reasons";
import type { VaultStateSnapshot } from "@/core/domain/types";
import { MERCHANTS, ruleCaseFile, snapshotBeforeRequest } from "./helpers/ruleCases";

const T = 20_000 * 86_400 + 30; // 30 s into a UTC day, minute bucket 0 of that day

function state(overrides: Partial<VaultStateSnapshot> = {}): VaultStateSnapshot {
    return {
        chainId: 31337,
        vault: "0x0000000000000000000000000000000000000001",
        paused: false,
        policyVersion: 1n,
        budget: 200_000n,
        spent: 0n,
        reserved: 0n,
        approvalThreshold: 50_000n,
        expiresAt: T + 7 * 86_400,
        maxPerMinute: 3,
        maxPerDay: 20,
        minuteBucket: BigInt(Math.floor(T / 60)),
        minuteCount: 0,
        dayBucket: BigInt(Math.floor(T / 86_400)),
        dayCount: 0,
        pendingCount: 0,
        vaultBalance: 1_000_000n,
        feeBps: 100,
        merchants: [MERCHANTS.A, MERCHANTS.B],
        blockTimestamp: T,
        blockNumber: 10n,
        ...overrides,
    };
}

describe("evaluatePrecheck — mirrors PolicyVault.spend steps 1..9", () => {
    it("passes an allowed, in-budget request below the threshold and predicts execution", () => {
        expect(evaluatePrecheck(state(), { merchant: MERCHANTS.A, amount: 30_000n })).toEqual({
            verdict: "pass",
            expected: "execute",
            fee: 300n,
        });
    });

    it("predicts pending when amount is one above the threshold, execute when equal", () => {
        expect(evaluatePrecheck(state(), { merchant: MERCHANTS.A, amount: 50_001n })).toEqual({
            verdict: "pass",
            expected: "pending",
            fee: 500n,
        });
        expect(evaluatePrecheck(state(), { merchant: MERCHANTS.A, amount: 50_000n })).toMatchObject({
            verdict: "pass",
            expected: "execute",
        });
    });

    it("F-09: blocks OVER_BUDGET when a <= R but a + fee > R, and passes when a + fee == R", () => {
        const s = state({ budget: 100_000n, approvalThreshold: 100_000n });
        expect(evaluatePrecheck(s, { merchant: MERCHANTS.A, amount: 100_000n })).toEqual({
            verdict: "block",
            reason: BlockReason.OVER_BUDGET,
            fee: 1_000n,
        });
        const exact = state({ budget: 101_000n, approvalThreshold: 101_000n });
        expect(evaluatePrecheck(exact, { merchant: MERCHANTS.A, amount: 100_000n }).verdict).toBe("pass");
    });

    it("counts reserved (pending) money against the remaining budget", () => {
        const s = state({ budget: 100_000n, reserved: 60_600n });
        expect(remainingBudget(s)).toBe(39_400n);
        expect(evaluatePrecheck(s, { merchant: MERCHANTS.A, amount: 40_000n })).toMatchObject({
            verdict: "block",
            reason: BlockReason.OVER_BUDGET,
        });
    });

    it("blocks EXPIRED exactly at expiresAt (timestamp >= expiresAt) but not one second before", () => {
        expect(evaluatePrecheck(state({ expiresAt: T }), { merchant: MERCHANTS.A, amount: 1n })).toMatchObject({
            verdict: "block",
            reason: BlockReason.EXPIRED,
        });
        expect(evaluatePrecheck(state({ expiresAt: T + 1 }), { merchant: MERCHANTS.A, amount: 1n }).verdict).toBe(
            "pass",
        );
    });

    it("treats a stale minute bucket as a fresh window (count resets to 0)", () => {
        const stale = state({ minuteBucket: BigInt(Math.floor(T / 60)) - 1n, minuteCount: 3 });
        expect(evaluatePrecheck(stale, { merchant: MERCHANTS.A, amount: 1_000n }).verdict).toBe("pass");
        const current = state({ minuteCount: 3 });
        expect(evaluatePrecheck(current, { merchant: MERCHANTS.A, amount: 1_000n })).toMatchObject({
            verdict: "block",
            reason: BlockReason.RATE_LIMIT_MINUTE,
        });
    });

    it("applies the contract's priority: paused beats every other reason, block beats pending", () => {
        const everythingWrong = state({ paused: true, expiresAt: T, budget: 1n });
        expect(evaluatePrecheck(everythingWrong, { merchant: MERCHANTS.X, amount: 60_000n })).toMatchObject({
            reason: BlockReason.PAUSED,
        });
        expect(evaluatePrecheck(state(), { merchant: MERCHANTS.X, amount: 60_000n })).toEqual({
            verdict: "block",
            reason: BlockReason.MERCHANT_NOT_ALLOWED,
            fee: 600n,
        });
    });

    it("matches merchant addresses case-insensitively (checksummed vs lower-case hex)", () => {
        const s = state({ merchants: ["0x000000000000000000000000000000000000dA15"] });
        expect(
            evaluatePrecheck(s, { merchant: "0x000000000000000000000000000000000000da15", amount: 1_000n }).verdict,
        ).toBe("pass");
    });

    it("rejects inputs the contract would revert on (amount 0, zero merchant) instead of predicting a record", () => {
        expect(() => evaluatePrecheck(state(), { merchant: MERCHANTS.A, amount: 0n })).toThrow(RangeError);
        expect(() =>
            evaluatePrecheck(state(), { merchant: "0x0000000000000000000000000000000000000000", amount: 1n }),
        ).toThrow(RangeError);
    });
});

describe("rule-cases.json parity (precheck side — same cases as chain/test/ruleCases.test.ts)", () => {
    for (const c of ruleCaseFile.cases) {
        it(`${c.id} → ${c.expected.outcome}${c.expected.reason ? ` reason ${c.expected.reason}` : ""}`, () => {
            const s = snapshotBeforeRequest(c);
            const amount = BigInt(c.request.amount);
            const r = evaluatePrecheck(s, { merchant: MERCHANTS[c.request.merchant], amount });
            const review = c.request.agentReviewRequest ?? false;
            const actual =
                r.verdict === "block"
                    ? { outcome: "blocked", reason: r.reason, flags: 0, fee: r.fee.toString() }
                    : {
                          outcome: r.expected === "pending" || review ? "pending" : "executed",
                          reason: 0,
                          flags: (amount > s.approvalThreshold ? 1 : 0) | (review ? 2 : 0),
                          fee: r.fee.toString(),
                      };
            expect(actual).toEqual(c.expected);
        });
    }
});
