"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ko } from "./ko";
import { applyLocale, type Locale } from "./locale";
import { MESSAGES, type Messages } from "./messages";

// UI language context (F-17, D-40, ADR-0008). The root layout passes the cookie's language as initialLocale, so the
// server HTML and the first client render agree (no flash, no hydration mismatch). Switching writes the cookie and
// <html lang>, then re-renders every client component — no reload, no server call.

type I18n = { locale: Locale; m: Messages; setLocale: (l: Locale) => void };

/** Outside a provider (single-component render tests): Korean, switching does nothing. */
const I18nContext = createContext<I18n>({ locale: "ko", m: ko, setLocale: () => {} });

export function LocaleProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
    const [locale, setState] = useState<Locale>(initialLocale);
    const setLocale = useCallback((l: Locale) => {
        applyLocale(l, document);
        setState(l);
    }, []);
    const value = useMemo(() => ({ locale, m: MESSAGES[locale], setLocale }), [locale, setLocale]);
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
    return useContext(I18nContext);
}

/**
 * Tab title in the selected language (F-17 ⑩): "<screen> · <brand>" — both parts from the dictionary
 * ("대시보드 · 곳간지기" / "Dashboard · Allowance").
 * Next.js commits the layout's metadata <title> ("<brand>") after this effect on first load and after client
 * navigation (observed in the T-17 browser check), so the title is re-applied whenever the <head> changes.
 */
export function useDocumentTitle(title: string): void {
    const brand = useI18n().m.common.brand;
    useEffect(() => {
        const wanted = `${title} · ${brand}`;
        const apply = () => {
            if (document.title !== wanted) document.title = wanted;
        };
        apply();
        const observer = new MutationObserver(apply);
        observer.observe(document.head, { childList: true, subtree: true, characterData: true });
        return () => observer.disconnect();
    }, [title, brand]);
}
