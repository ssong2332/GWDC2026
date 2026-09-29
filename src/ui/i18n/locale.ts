import { UI_LOCALE } from "@/config/constants";

// F-17 UI language rules (Architecture 10 "UI 언어", D-40). Pure — imported by the server root layout and by tests,
// so no "use client" here.

export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** Only the exact value "en" selects English; anything else (missing, empty, "EN", "ja", tampered) is the default ko. */
export function resolveLocale(raw: string | null | undefined): Locale {
    return raw === "en" ? "en" : UI_LOCALE.default;
}

/** Cookie written by the browser (not HttpOnly; no Secure — the app runs on http://127.0.0.1, D-17). */
export function localeCookie(l: Locale): string {
    return `${UI_LOCALE.cookie}=${l}; Path=/; Max-Age=${UI_LOCALE.maxAgeS}; SameSite=Lax`;
}

/** Stores the choice and mirrors it on <html lang>. `doc` is `document` in the browser, a plain object in tests. */
export function applyLocale(l: Locale, doc: { cookie: string; documentElement: { lang: string } }): void {
    doc.cookie = localeCookie(l);
    doc.documentElement.lang = l;
}
