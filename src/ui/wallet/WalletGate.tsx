"use client";

import type { ReactNode } from "react";
import type { Hex } from "@/core/domain/types";
import { ErrorNotice } from "../components/AsyncView";
import { chainLabel } from "./chains";
import { evaluateGate } from "./gate";
import { useWallet } from "./WalletProvider";

// WalletGate (Architecture 10): signing controls stay visible but disabled unless the connected address is the vault
// owner on the server's chain; the reason and the fix (connect / switch network) are shown next to them.

export function WalletGate({ target, children }: { target: { owner: Hex; chainId: number } | null; children: ReactNode }) {
    const { ready, wallet, error, connect, switchChain } = useWallet();
    const gate = ready ? evaluateGate(wallet, target) : ({ allowed: false, reason: "loading" } as const);

    let notice: ReactNode = null;
    if (!gate.allowed) {
        switch (gate.reason) {
            case "loading":
                notice = <p className="gate-note">Checking wallet…</p>;
                break;
            case "no_wallet":
                notice = <p className="gate-note">No browser wallet detected. Install a wallet extension (e.g. MetaMask) to sign — view only.</p>;
                break;
            case "disconnected":
                notice = (
                    <p className="gate-note">
                        Wallet not connected.{" "}
                        <button type="button" className="btn-secondary" onClick={() => void connect()}>
                            Connect wallet
                        </button>
                    </p>
                );
                break;
            case "wrong_chain":
                notice = (
                    <p className="gate-note">
                        Wallet is on {wallet.chainId === null ? "an unknown network" : chainLabel(wallet.chainId)}.{" "}
                        <button type="button" className="btn-secondary" onClick={() => void switchChain(target!.chainId)}>
                            Switch to {chainLabel(target!.chainId)}
                        </button>
                    </p>
                );
                break;
            case "not_owner":
                notice = <p className="gate-note">Connected address is not the owner (view only).</p>;
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
