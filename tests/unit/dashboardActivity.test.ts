import { describe, expect, it } from "vitest";
import { budgetView, newestFirst, openPendings, type ActivityItemDto } from "@/ui/dashboard/activity";

// Dashboard derivations (PRD 화면 ②): the approval inbox and the budget summary.

const R1 = `0x${"01".repeat(32)}` as const;
const R2 = `0x${"02".repeat(32)}` as const;
const R3 = `0x${"03".repeat(32)}` as const;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

const item = (over: Partial<ActivityItemDto>): ActivityItemDto => ({
    requestId: null,
    kind: "policy_set",
    merchantId: null,
    amount: null,
    fee: null,
    reason: null,
    flags: null,
    txHash: tx(0),
    blockTimestamp: 0,
    judgmentStatus: null,
    ...over,
});

describe("openPendings (승인 대기함)", () => {
    it("empty activity → empty inbox", () => {
        expect(openPendings([])).toEqual([]);
    });

    it("a pending without a later approval/rejection is open; approved and rejected ones are not", () => {
        const items = [
            item({ kind: "pending", requestId: R1, txHash: tx(1), flags: 1 }),
            item({ kind: "pending", requestId: R2, txHash: tx(2), flags: 2 }),
            item({ kind: "pending", requestId: R3, txHash: tx(3), flags: 1 }),
            item({ kind: "approved", requestId: R1, txHash: tx(4) }),
            item({ kind: "executed", requestId: R1, txHash: tx(4) }),
            item({ kind: "rejected", requestId: R3, txHash: tx(5) }),
        ];
        expect(openPendings(items).map((i) => i.requestId)).toEqual([R2]);
    });

    it("request ids are compared case-insensitively", () => {
        const items = [item({ kind: "pending", requestId: R1, txHash: tx(1) }), item({ kind: "approved", requestId: R1.toUpperCase().replace("0X", "0x") as `0x${string}` })];
        expect(openPendings(items)).toEqual([]);
    });
});

describe("newestFirst", () => {
    it("orders by block time descending without mutating the input", () => {
        const items = [item({ blockTimestamp: 1, txHash: tx(1) }), item({ blockTimestamp: 3, txHash: tx(3) }), item({ blockTimestamp: 2, txHash: tx(2) })];
        expect(newestFirst(items).map((i) => i.blockTimestamp)).toEqual([3, 2, 1]);
        expect(items.map((i) => i.blockTimestamp)).toEqual([1, 3, 2]);
    });
});

describe("budgetView", () => {
    it("remaining = budget − spent − reserved (decimal strings in, bigint out)", () => {
        expect(budgetView({ budget: "200000", spent: "90900", reserved: "15150" })).toEqual({
            budget: 200_000n,
            spent: 90_900n,
            reserved: 15_150n,
            remaining: 93_950n,
        });
    });

    it("no policy yet → all zero", () => {
        expect(budgetView({ budget: "0", spent: "0", reserved: "0" }).remaining).toBe(0n);
    });

    it("never negative even if the numbers are inconsistent", () => {
        expect(budgetView({ budget: "10", spent: "20", reserved: "0" }).remaining).toBe(0n);
    });
});
