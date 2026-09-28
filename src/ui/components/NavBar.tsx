"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { chainLabel } from "../wallet/chains";
import { useWallet } from "../wallet/WalletProvider";

// Shared navigation + wallet button (Architecture 10 라우팅). Audit and Efficiency links arrive with their screens (T-06).
const LINKS = [
    { href: "/delegate", label: "Delegate" },
    { href: "/dashboard", label: "Dashboard" },
] as const;

function WalletButton() {
    const { ready, wallet, connect } = useWallet();
    if (!ready) return <span className="wallet-status muted">Checking wallet…</span>;
    if (wallet.status === "no_wallet") return <span className="wallet-status muted">No wallet detected</span>;
    if (wallet.status === "disconnected")
        return (
            <button type="button" className="btn-secondary" onClick={() => void connect()}>
                Connect wallet
            </button>
        );
    return (
        <span className="wallet-status" title={wallet.address ?? undefined}>
            {wallet.address?.slice(0, 6)}…{wallet.address?.slice(-4)} · {wallet.chainId === null ? "unknown network" : chainLabel(wallet.chainId)}
        </span>
    );
}

export function NavBar() {
    const path = usePathname();
    return (
        <header className="navbar">
            <span className="brand">Agent Spending Control</span>
            <nav aria-label="Main">
                <ul>
                    {LINKS.map((l) => (
                        <li key={l.href}>
                            <Link href={l.href} aria-current={path === l.href ? "page" : undefined}>
                                {l.label}
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>
            <WalletButton />
        </header>
    );
}
