"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";
import { useI18n } from "../i18n/LocaleProvider";
import { chainLabel } from "../wallet/chains";
import { useWallet } from "../wallet/WalletProvider";

// Shared navigation + language buttons + wallet button (Architecture 10 라우팅, "UI 언어" 전환).
const LINKS = [
    { href: "/delegate", key: "delegate" },
    { href: "/dashboard", key: "dashboard" },
    { href: "/audit", key: "audit" },
    { href: "/efficiency", key: "efficiency" },
] as const;

function WalletButton() {
    const { m } = useI18n();
    const { ready, wallet, connect } = useWallet();
    if (!ready) return <span className="wallet-status muted">{m.wallet.checking}</span>;
    if (wallet.status === "no_wallet") return <span className="wallet-status muted">{m.wallet.noWalletDetected}</span>;
    if (wallet.status === "disconnected")
        return (
            <button type="button" className="btn-secondary" onClick={() => void connect()}>
                {m.wallet.connect}
            </button>
        );
    return (
        <span className="wallet-status" title={wallet.address ?? undefined}>
            {wallet.address?.slice(0, 6)}…{wallet.address?.slice(-4)} · {wallet.chainId === null ? m.wallet.unknownNetwork : chainLabel(wallet.chainId)}
        </span>
    );
}

export function NavBar() {
    const { m } = useI18n();
    const path = usePathname();
    return (
        <header className="navbar">
            <span className="brand">{m.common.brand}</span>
            <nav aria-label={m.nav.main}>
                <ul>
                    {LINKS.map((l) => (
                        <li key={l.href}>
                            <Link href={l.href} aria-current={path === l.href ? "page" : undefined}>
                                {m.nav.links[l.key]}
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>
            <LanguageSwitcher />
            <WalletButton />
        </header>
    );
}
