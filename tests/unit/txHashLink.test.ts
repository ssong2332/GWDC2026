import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TxHashLink } from "@/ui/components/TxHashLink";
import { en } from "@/ui/i18n/en";
import { ko } from "@/ui/i18n/ko";
import { LocaleProvider } from "@/ui/i18n/LocaleProvider";

// T-16 ①: the explorer link's accessible name must be the full tx hash (aria-label), not the abbreviated visible text.

const H = "0x975b21728f112a2e2d07bb036eb7e17fe7dca35d5c701b468650252263372755" as const;
const EXPLORER = "https://sepolia.basescan.org/tx/";

const render = (props: { hash: `0x${string}`; explorerTxUrl: string | null; full?: boolean }) => renderToStaticMarkup(createElement(TxHashLink, props));
const attr = (html: string, name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1];

describe("TxHashLink accessible name", () => {
    it("explorer link (abbreviated) → aria-label is the full 66-char hash", () => {
        const html = render({ hash: H, explorerTxUrl: EXPLORER });
        expect(html.startsWith("<a ")).toBe(true);
        expect(attr(html, "aria-label")).toBe(H);
        expect(attr(html, "aria-label")).toHaveLength(66);
    });
    it("explorer link keeps href, title (explorer hint) and abbreviated visible text unchanged", () => {
        const html = render({ hash: H, explorerTxUrl: EXPLORER });
        expect(attr(html, "href")).toBe(`${EXPLORER}${H}`);
        // T-17: the explorer hint follows the UI language (default ko outside a provider).
        expect(attr(html, "title")).toBe(`${H} (${ko.common.opensExplorer})`);
        expect(attr(html, "target")).toBe("_blank");
        expect(html).toContain(`<span class="hash-medium">0x975b2172…63372755</span>`);
        expect(html).toContain(`<span class="hash-compact">0x975b…2755</span>`);
    });
    it("explorer hint in English when the UI language is en (T-17)", () => {
        const html = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "en", children: createElement(TxHashLink, { hash: H, explorerTxUrl: EXPLORER }) }));
        expect(attr(html, "title")).toBe(`${H} (${en.common.opensExplorer})`);
        expect(en.common.opensExplorer).toBe("opens the block explorer");
    });
    it("explorer link with full → aria-label is the hash and visible text is still the full hash", () => {
        const html = render({ hash: H, explorerTxUrl: EXPLORER, full: true });
        expect(attr(html, "aria-label")).toBe(H);
        expect(html).toContain(`>${H}</a>`);
        expect(html).not.toContain("hash-medium");
    });
    it("no explorer (local node) → plain <code>, no aria-label (not a link; name is not allowed on code)", () => {
        const html = render({ hash: H, explorerTxUrl: null });
        expect(html.startsWith("<code ")).toBe(true);
        expect(attr(html, "aria-label")).toBeUndefined();
        expect(attr(html, "title")).toBe(H);
    });
    it("no explorer + full → <code> with the full hash text, no aria-label", () => {
        const html = render({ hash: H, explorerTxUrl: null, full: true });
        expect(html).toBe(`<code class="hash" title="${H}">${H}</code>`);
    });
});
