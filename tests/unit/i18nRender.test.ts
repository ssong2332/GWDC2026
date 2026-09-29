import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorNotice } from "@/ui/components/AsyncView";
import { ReasonBadge } from "@/ui/components/ReasonBadge";
import { en } from "@/ui/i18n/en";
import { ko } from "@/ui/i18n/ko";
import { LanguageSwitcher } from "@/ui/i18n/LanguageSwitcher";
import { LocaleProvider } from "@/ui/i18n/LocaleProvider";
import type { Locale } from "@/ui/i18n/locale";

// F-17 ②⑥⑧ (Architecture "UI 언어 테스트" ⑩~⑫): components render the selected dictionary; server/wallet detail
// stays in its original English under a translated title.

const render = (locale: Locale, node: ReactNode) => renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: locale, children: node }));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const blocked6 = createElement(ReasonBadge, { kind: "blocked", reason: 6, flags: null });
const pending3 = createElement(ReasonBadge, { kind: "pending", reason: null, flags: 3 });
const rateLimited = (message: string) => createElement(ErrorNotice, { error: { code: "KILN_RATE_LIMITED", message } });
const switcher = createElement(LanguageSwitcher);

describe("ko (⑩)", () => {
    it("ReasonBadge: block reason 6 and both pending flags in Korean", () => {
        expect(render("ko", blocked6)).toContain(esc(ko.reasons[6]));
        const html = render("ko", pending3);
        expect(html).toContain(esc(ko.flags[1]));
        expect(html).toContain(esc(ko.flags[2]));
        expect(html).not.toContain(esc(en.flags[1]));
    });
    it("ErrorNotice: Korean title", () => {
        expect(render("ko", rateLimited(""))).toContain(`<strong>${esc(ko.errors.KILN_RATE_LIMITED)}</strong>`);
    });
    it("LanguageSwitcher: group named in Korean, the Korean button is pressed", () => {
        const html = render("ko", switcher);
        expect(html).toContain(`role="group" aria-label="${ko.nav.language}"`);
        expect(html).toMatch(/<button[^>]*lang="ko"[^>]*aria-pressed="true"[^>]*>한국어<\/button>/);
        expect(html).toMatch(/<button[^>]*lang="en"[^>]*aria-pressed="false"[^>]*>English<\/button>/);
    });
    it("unknown block reason → dictionary fallback with the code", () => {
        expect(render("ko", createElement(ReasonBadge, { kind: "blocked", reason: 42, flags: null }))).toContain(esc(ko.reasons.unknown({ code: 42 })));
    });
});

describe("en (⑪)", () => {
    it("same components in English", () => {
        expect(render("en", blocked6)).toContain(esc(en.reasons[6]));
        expect(render("en", pending3)).toContain(esc(en.flags[2]));
        expect(render("en", rateLimited(""))).toContain(`<strong>${esc(en.errors.KILN_RATE_LIMITED)}</strong>`);
        const html = render("en", switcher);
        expect(html).toContain(`aria-label="Language"`);
        expect(html).toMatch(/<button[^>]*lang="en"[^>]*aria-pressed="true"[^>]*>English<\/button>/);
    });
});

describe("error detail (⑫, F-17 ⑧)", () => {
    it("server message → original text as an English detail under the Korean title", () => {
        const html = render("ko", rateLimited("Kiln request failed (HTTP 429)"));
        expect(html).toContain(`<span class="notice-detail" lang="en">Kiln request failed (HTTP 429)</span>`);
        expect(html).toContain(esc(ko.errors.KILN_RATE_LIMITED));
    });
    it("message equal to the English dictionary title → no detail (ko and en)", () => {
        expect(render("ko", rateLimited(en.errors.KILN_RATE_LIMITED))).not.toContain("notice-detail");
        expect(render("en", rateLimited(en.errors.KILN_RATE_LIMITED))).not.toContain("notice-detail");
    });
    it("retry button label follows the language", () => {
        const withRetry = (l: Locale) => render(l, createElement(ErrorNotice, { error: { code: "INTERNAL", message: "" }, onRetry: () => {} }));
        expect(withRetry("ko")).toContain(`>${ko.common.retry}</button>`);
        expect(withRetry("en")).toContain(`>${en.common.retry}</button>`);
    });
});
