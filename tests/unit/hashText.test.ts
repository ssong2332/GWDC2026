import { describe, expect, it } from "vitest";
import { compactHash } from "@/ui/components/hashText";

// T-09 ②: narrow-screen dashboard Tx column shows e.g. "0x975b…2755" (user decision "줄여서 표시").

const H = "0x975b2172aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa63372755";

describe("compactHash", () => {
    it("32-byte tx hash → first 6 chars (incl. 0x) + … + last 4", () => {
        expect(H).toHaveLength(66);
        expect(compactHash(H)).toBe("0x975b…2755");
    });
    it("12 chars (one longer than the compact form) → abbreviated", () => {
        expect(compactHash("0x1234567890")).toBe("0x1234…7890");
    });
    it("11 chars or fewer → unchanged (abbreviating would not shorten it)", () => {
        expect(compactHash("0x123456789")).toBe("0x123456789");
        expect(compactHash("0xab")).toBe("0xab");
    });
    it("no 0x prefix / non-hex → abbreviated by position only (display helper, not a validator)", () => {
        expect(compactHash("zz975b2172aaaa63372755")).toBe("zz975b…2755");
    });
    it("empty string → empty string", () => {
        expect(compactHash("")).toBe("");
    });
});
