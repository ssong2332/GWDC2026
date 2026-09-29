import { describe, expect, it } from "vitest";
import { UI_LOCALE } from "@/config/constants";
import { LOCALES, applyLocale, localeCookie, resolveLocale } from "@/ui/i18n/locale";

// F-17 ①②⑤ (Architecture 10 "UI 언어", D-40): default ko, only the exact value "en" selects English,
// the choice is kept in the `lang` cookie and mirrored on <html lang>.

describe("resolveLocale", () => {
    it("no choice yet (undefined / null / empty) → ko", () => {
        expect(resolveLocale(undefined)).toBe("ko");
        expect(resolveLocale(null)).toBe("ko");
        expect(resolveLocale("")).toBe("ko");
    });
    it("exact values → that locale", () => {
        expect(resolveLocale("en")).toBe("en");
        expect(resolveLocale("ko")).toBe("ko");
    });
    it("anything else (wrong case, other language, tampered, padded) → ko — no trimming or case folding", () => {
        for (const raw of ["EN", "En", "ja", "en;x", " en", "en ", "english", "ko-KR"]) expect(resolveLocale(raw)).toBe("ko");
    });
    it("LOCALES lists exactly ko and en, default from UI_LOCALE", () => {
        expect([...LOCALES]).toEqual(["ko", "en"]);
        expect(UI_LOCALE).toEqual({ cookie: "lang", maxAgeS: 31536000, default: "ko" });
    });
});

describe("localeCookie", () => {
    it("exact cookie string (Path=/, one year, Lax, no Secure/HttpOnly)", () => {
        expect(localeCookie("en")).toBe("lang=en; Path=/; Max-Age=31536000; SameSite=Lax");
        expect(localeCookie("ko")).toBe("lang=ko; Path=/; Max-Age=31536000; SameSite=Lax");
    });
});

describe("applyLocale", () => {
    it("writes the cookie and <html lang>, and switching back restores ko", () => {
        const doc = { cookie: "", documentElement: { lang: "ko" } };
        applyLocale("en", doc);
        expect(doc.cookie).toBe("lang=en; Path=/; Max-Age=31536000; SameSite=Lax");
        expect(doc.documentElement.lang).toBe("en");
        applyLocale("ko", doc);
        expect(doc.cookie).toBe("lang=ko; Path=/; Max-Age=31536000; SameSite=Lax");
        expect(doc.documentElement.lang).toBe("ko");
    });
});
