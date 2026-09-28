import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BlockReason, PendingFlag, blockReasonLabel, pendingFlagLabels } from "@/core/domain/reasons";

const SOL = fs.readFileSync(path.resolve(__dirname, "../../chain/contracts/PolicyVault.sol"), "utf8");

function solConstants(prefix: string): Record<string, number> {
    const out: Record<string, number> = {};
    const re = new RegExp(`uint8 internal constant ${prefix}_([A-Z_]+) = (\\d+);`, "g");
    for (const m of SOL.matchAll(re)) out[m[1]] = Number(m[2]);
    return out;
}

describe("reason and flag codes are 1:1 with PolicyVault.sol", () => {
    it("every REASON_* constant in the contract has the same numeric BlockReason in TS (and vice versa)", () => {
        const sol = solConstants("REASON");
        expect(Object.keys(sol)).toHaveLength(8);
        const ts = Object.fromEntries(
            Object.entries(BlockReason).filter(([k, v]) => typeof v === "number" && k !== "NONE"),
        );
        expect(ts).toEqual(sol);
        expect(BlockReason.NONE).toBe(0);
    });

    it("every FLAG_* constant matches PendingFlag", () => {
        expect(solConstants("FLAG")).toEqual({ ...PendingFlag });
    });

    it("maps codes to the English UI labels from Architecture", () => {
        expect(blockReasonLabel(BlockReason.MERCHANT_NOT_ALLOWED)).toBe("Merchant not allowed");
        expect(blockReasonLabel(BlockReason.OVER_BUDGET)).toBe("Over budget (incl. fee)");
        expect(pendingFlagLabels(3)).toEqual(["Above approval threshold", "AI flagged / review requested"]);
        expect(pendingFlagLabels(0)).toEqual([]);
    });

    it("returns an explicit unknown label for codes outside the table", () => {
        expect(blockReasonLabel(0)).toBe("Unknown reason (0)");
        expect(blockReasonLabel(9)).toBe("Unknown reason (9)");
    });
});
