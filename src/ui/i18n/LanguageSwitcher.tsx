"use client";

import { useI18n } from "./LocaleProvider";
import type { Locale } from "./locale";

// NavBar language buttons (Architecture 10 "UI 언어" 전환). Each button is labelled in its own language, so the
// names are not dictionary entries; the current language is aria-pressed.

const OPTIONS: { locale: Locale; name: string }[] = [
    { locale: "ko", name: "한국어" },
    { locale: "en", name: "English" },
];

export function LanguageSwitcher() {
    const { locale, m, setLocale } = useI18n();
    return (
        <div role="group" aria-label={m.nav.language} className="lang-switch">
            {OPTIONS.map((o) => (
                <button key={o.locale} type="button" lang={o.locale} aria-pressed={locale === o.locale} className="lang-btn" onClick={() => setLocale(o.locale)}>
                    {o.name}
                </button>
            ))}
        </div>
    );
}
