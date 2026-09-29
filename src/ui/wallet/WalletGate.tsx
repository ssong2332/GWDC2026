"use client";

import type { ReactNode } from "react";
import type { Hex } from "@/core/domain/types";
import { ErrorNotice } from "../components/AsyncView";
import { useI18n } from "../i18n/LocaleProvider";
import { chainLabel } from "./chains";
import { evaluateGate } from "./gate";
import { useWallet } from "./WalletProvider";

// WalletGate (Architecture 10): signing controls stay visible but disabled unless the connected address is the vault
// owner on the server's chain; the reason and the fix (connect / switch network) are shown next to them.

export function WalletGate({ target, children }: { target: { owner: Hex; chainId: number } | null; children: ReactNode }) {
    const { m } = useI18n();
    const g = m.wallet.gate;
    const { ready, wallet, error, connect, switchChain } = useWallet();
    const gate = ready ? evaluateGate(wallet, target) : ({ allowed: false, reason: "loading" } as const);

    let notice: ReactNode = null;
    if (!gate.allowed) {
        switch (gate.reason) {
            case "loading":
                notice = <p className="gate-note">{g.loading}</p>;
                break;
            case "no_wallet":
                notice = <p className="gate-note">{g.no_wallet}</p>;
                break;
            case "disconnected":
                notice = (
                    <p className="gate-note">
                        {g.disconnected}{" "}
                        <button type="button" className="btn-secondary" onClick={() => void connect()}>
                            {m.wallet.connect}
                        </button>
                    </p>
                );
                break;
            case "wrong_chain":
                notice = (
                    <p className="gate-note">
                        {g.wrong_chain({ chain: wallet.chainId === null ? m.wallet.anUnknownNetwork : chainLabel(wallet.chainId) })}{" "}
                        <button type="button" className="btn-secondary" onClick={() => void switchChain(target!.chainId)}>
                            {m.wallet.switchTo({ chain: chainLabel(target!.chainId) })}
                        </button>
                    </p>
                );
                break;
            case "not_owner":
                notice = <p className="gate-note">{g.not_owner}</p>;
                break;
        }
    }
    return (
        <div className="wallet-gate">
            {notice}
            {error ? <ErrorNotice error={error} /> : null}
            <fieldset className="gate-fieldset" disabled={!gate.allowed}>
                {children}
            </fieldset>
        </div>
    );
}
