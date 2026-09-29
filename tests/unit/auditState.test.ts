import { describe, expect, it } from "vitest";
import { hashVerdict, normalizeTxInput } from "@/ui/audit/auditState";

// ③ Audit screen input rule (Architecture 10: `^0x[0-9a-fA-F]{64}$` checked before any request) and hash badge.

const H = `0x${"a1".repeat(32)}`;

describe("normalizeTxInput", () => {
    it("valid hash (surrounding spaces trimmed) → ok", () => {
        expect(normalizeTxInput(`  ${H} `)).toEqual({ ok: true, tx: H });
        expect(normalizeTxInput(H.toUpperCase().replace("0X", "0x"))).toMatchObject({ ok: true });
    });
    it("empty → empty (guidance, not an error)", () => {
        expect(normalizeTxInput("   ")).toEqual({ ok: false, reason: "empty" });
    });
    it("63 / 65 hex digits, missing 0x, non-hex → invalid", () => {
        for (const bad of [H.slice(0, -1), `${H}0`, H.slice(2), `0x${"zz".repeat(32)}`]) expect(normalizeTxInput(bad)).toEqual({ ok: false, reason: "invalid" });
    });
});

describe("hashVerdict", () => {
    // T-17 (D-41): the pure helper returns a dictionary key; the screen looks up m.audit.hashVerdict[key].
    it("true → match, false → mismatch, null → no local evidence", () => {
        expect(hashVerdict(true)).toEqual({ key: "match", tone: "ok" });
        expect(hashVerdict(false)).toEqual({ key: "mismatch", tone: "blocked" });
        expect(hashVerdict(null)).toEqual({ key: "no_local", tone: "pending" });
    });
});
