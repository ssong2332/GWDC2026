"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ApiError } from "../apiClient";
import { describeWalletError } from "./contractCall";
import { connectWallet, injectedProvider, readWallet, switchWalletChain, type Eip1193Provider } from "./eip1193";
import type { WalletSnapshot } from "./gate";

// Wallet context (Architecture 10 지갑 상태, D-15): EIP-1193 window.ethereum, accountsChanged / chainChanged subscription.

type WalletContextValue = {
    ready: boolean;
    wallet: WalletSnapshot;
    provider: Eip1193Provider | null;
    error: ApiError | null;
    connect: () => Promise<void>;
    switchChain: (chainId: number) => Promise<void>;
};

const NO_WALLET: WalletSnapshot = { status: "no_wallet", address: null, chainId: null };
const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
    const [provider, setProvider] = useState<Eip1193Provider | null>(null);
    const [wallet, setWallet] = useState<WalletSnapshot>(NO_WALLET);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);

    const refresh = useCallback(async (p: Eip1193Provider | null) => {
        try {
            setWallet(await readWallet(p));
        } catch (err) {
            setError(describeWalletError(err));
        } finally {
            setReady(true);
        }
    }, []);

    useEffect(() => {
        const p = injectedProvider();
        setProvider(p);
        void refresh(p);
        if (!p?.on) return;
        const onChange = () => void refresh(p);
        p.on("accountsChanged", onChange);
        p.on("chainChanged", onChange);
        return () => {
            p.removeListener?.("accountsChanged", onChange);
            p.removeListener?.("chainChanged", onChange);
        };
    }, [refresh]);

    const connect = useCallback(async () => {
        if (!provider) {
            setError({ code: "NO_WALLET", message: "" });
            return;
        }
        setError(null);
        try {
            setWallet(await connectWallet(provider));
        } catch (err) {
            setError(describeWalletError(err));
        }
    }, [provider]);

    const switchChain = useCallback(
        async (chainId: number) => {
            if (!provider) return;
            setError(null);
            try {
                await switchWalletChain(provider, chainId);
                await refresh(provider);
            } catch (err) {
                setError(describeWalletError(err));
            }
        },
        [provider, refresh],
    );

    const value = useMemo(() => ({ ready, wallet, provider, error, connect, switchChain }), [ready, wallet, provider, error, connect, switchChain]);
    return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
    const v = useContext(WalletContext);
    if (!v) throw new Error("useWallet must be used inside <WalletProvider>");
    return v;
}
