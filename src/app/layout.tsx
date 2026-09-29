import type { Metadata } from "next";
import { cookies } from "next/headers";
import { UI_LOCALE } from "@/config/constants";
import { NavBar } from "@/ui/components/NavBar";
import { LocaleProvider } from "@/ui/i18n/LocaleProvider";
import { resolveLocale } from "@/ui/i18n/locale";
import { DEFAULT_BRAND } from "@/ui/i18n/messages";
import { WalletProvider } from "@/ui/wallet/WalletProvider";
import "./globals.css";

export const metadata: Metadata = {
    title: DEFAULT_BRAND,
    description: "Delegate an event budget to an AI agent — limits enforced by code and PolicyVault, every decision on record.",
};

// F-17 (D-40, ADR-0008): the `lang` cookie decides the first HTML's language and <html lang>, so the server render and
// the client's first render agree (no flash). Reading cookies makes every page dynamically rendered.
export default async function RootLayout({ children }: LayoutProps<"/">) {
    const locale = resolveLocale((await cookies()).get(UI_LOCALE.cookie)?.value);
    return (
        <html lang={locale}>
            <body>
                <LocaleProvider initialLocale={locale}>
                    <WalletProvider>
                        <NavBar />
                        <main className="container">{children}</main>
                    </WalletProvider>
                </LocaleProvider>
            </body>
        </html>
    );
}
