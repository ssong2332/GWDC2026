import { describe, expect, it } from "vitest";
import { quoteFee } from "@/core/domain/fee";

describe("quoteFee (D-06: floor(amount * feeBps / 10000))", () => {
    it("charges 1% of a round amount", () => {
        expect(quoteFee(30_000n, 100)).toBe(300n);
    });

    it("rounds down to 0 just below the first whole won (99 won at 1%)", () => {
        expect(quoteFee(99n, 100)).toBe(0n);
    });

    it("charges exactly 1 won at 100 and still 1 won at 101 (floor)", () => {
        expect(quoteFee(100n, 100)).toBe(1n);
        expect(quoteFee(101n, 100)).toBe(1n);
    });

    it("returns 0 when feeBps is 0 and scales with the max fee (1000 bps = 10%)", () => {
        expect(quoteFee(12_345n, 0)).toBe(0n);
        expect(quoteFee(12_345n, 1000)).toBe(1_234n);
    });

    it("rejects a negative amount or an out-of-range feeBps instead of computing a fee", () => {
        expect(() => quoteFee(-1n, 100)).toThrow(RangeError);
        expect(() => quoteFee(100n, 1001)).toThrow(RangeError);
        expect(() => quoteFee(100n, -1)).toThrow(RangeError);
    });
});
