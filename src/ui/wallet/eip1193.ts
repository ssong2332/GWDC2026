import { getAddress } from "viem";
import type { Hex } from "@/core/domain/types";
import { addChainParams, chainFor } from "./chains";
import type { WalletSnapshot } from "./gate";

// Minimal EIP-1193 access for the injected browser wallet (D-15: viem custom(window.ethereum), no wagmi).

export type Eip1193Provider = {
    request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    on?(event: string, listener: (...args: unknown[]) => void): void;
    removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

const UNRECOGNIZED_CHAIN = 4902;

function snapshot(accounts: unknown, chainIdHex: unknown): WalletSnapshot {
    const chainId = typeof chainIdHex === "string" ? Number.parseInt(chainIdHex, 16) : null;
    const first = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
    if (!first) return { status: "disconnected", address: null, chainId };
    return { status: "connected", address: getAddress(first) as Hex, chainId };
}

/** Current wallet state without prompting the user. */
export async function readWallet(provider: Eip1193Provider | null): Promise<WalletSnapshot> {
    if (!provider) return { status: "no_wallet", address: null, chainId: null };
    const [accounts, chainId] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
    return snapshot(accounts, chainId);
}

/** Prompts the user to connect (eth_requestAccounts). Provider errors (4001 rejection) propagate. */
export async function connectWallet(provider: Eip1193Provider): Promise<WalletSnapshot> {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    return snapshot(accounts, await provider.request({ method: "eth_chainId" }));
}

/** wallet_switchEthereumChain; if the wallet does not know the chain (4902), wallet_addEthereumChain first. */
export async function switchWalletChain(provider: Eip1193Provider, chainId: number): Promise<void> {
    const chain = chainFor(chainId);
    if (!chain) throw Object.assign(new Error(`unsupported chain ${chainId}`), { code: "WRONG_NETWORK" });
    const hexId = `0x${chainId.toString(16)}`;
    try {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (err) {
        if ((err as { code?: unknown }).code !== UNRECOGNIZED_CHAIN) throw err;
        await provider.request({ method: "wallet_addEthereumChain", params: [addChainParams(chain)] });
    }
}

/** The injected provider, if any (browser only). */
export function injectedProvider(): Eip1193Provider | null {
    if (typeof window === "undefined") return null;
    return ((window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null) as Eip1193Provider | null;
}
