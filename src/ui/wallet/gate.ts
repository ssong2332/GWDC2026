import type { Hex } from "@/core/domain/types";

// WalletGate rule (Architecture 10 권한·네트워크 가드): signing controls are enabled only for the vault owner on the
// server's chain. This is a UI guard — the contract's onlyOwner is the authority.

export type WalletSnapshot = { status: "no_wallet" | "disconnected" | "connected"; address: Hex | null; chainId: number | null };

export type GateReason = "loading" | "no_wallet" | "disconnected" | "wrong_chain" | "not_owner";
export type GateResult = { allowed: true } | { allowed: false; reason: GateReason };

export function evaluateGate(w: WalletSnapshot, target: { owner: Hex; chainId: number } | null): GateResult {
    if (target === null) return { allowed: false, reason: "loading" };
    if (w.status === "no_wallet") return { allowed: false, reason: "no_wallet" };
    if (w.status === "disconnected" || w.address === null) return { allowed: false, reason: "disconnected" };
    if (w.chainId !== target.chainId) return { allowed: false, reason: "wrong_chain" };
    if (w.address.toLowerCase() !== target.owner.toLowerCase()) return { allowed: false, reason: "not_owner" };
    return { allowed: true };
}
