import { createPublicClient, createWalletClient, custom } from "viem";
import { policyVaultAbi } from "@/adapters/chain/generated/PolicyVault";
import type { ConfirmResponse, PrepareResponse } from "@/app/api/_lib/dto";
import type { Hex } from "@/core/domain/types";
import { postJson, type ApiError, type ApiResult } from "../apiClient";
import { ERROR_MESSAGES } from "../errorMessages";
import { chainFor } from "./chains";
import { describeWalletError, toContractCall } from "./contractCall";
import type { Eip1193Provider } from "./eip1193";

// useOwnerAction state machine (Architecture 10 서명 흐름):
// idle → preparing → simulating → awaiting_signature → confirming → done; any step can end in error.
// The server builds the evidence and the call (prepare), the browser wallet signs, the server confirms from the chain.

export type PreparedAction = PrepareResponse;
export type OwnerActionBody = Record<string, unknown> & { kind: "policy_set" | "approval" | "rejection" | "pause" };

export type OwnerActionState =
    | { step: "idle" }
    | { step: "preparing" }
    | { step: "simulating" }
    | { step: "awaiting_signature" }
    | { step: "confirming"; txHash: Hex }
    | { step: "done"; txHash: Hex; evidenceHash: Hex }
    | { step: "error"; at: "preparing" | "simulating" | "awaiting_signature" | "confirming"; error: ApiError; txHash: Hex | null };

export type OwnerActionPorts = {
    prepare(body: OwnerActionBody): Promise<ApiResult<PreparedAction>>;
    /** Throws (wallet/contract error) if the call would revert — shown before the signature prompt. */
    simulate(p: PreparedAction): Promise<void>;
    /** Asks the wallet to sign and send; resolves with the tx hash. */
    send(p: PreparedAction): Promise<Hex>;
    confirm(i: { evidenceId: string; txHash: Hex }): Promise<ApiResult<ConfirmResponse>>;
};

export const initialOwnerActionState: OwnerActionState = { step: "idle" };

export function isBusy(s: OwnerActionState): boolean {
    return s.step === "preparing" || s.step === "simulating" || s.step === "awaiting_signature" || s.step === "confirming";
}

export async function runOwnerAction(
    ports: OwnerActionPorts,
    body: OwnerActionBody,
    emit: (s: OwnerActionState) => void,
    opts: { walletChainId?: number | null } = {},
): Promise<OwnerActionState> {
    const end = (s: OwnerActionState) => {
        emit(s);
        return s;
    };
    emit({ step: "preparing" });
    const prepared = await ports.prepare(body);
    if (!prepared.ok) return end({ step: "error", at: "preparing", error: prepared.error, txHash: null });
    const p = prepared.data;

    emit({ step: "simulating" });
    if (opts.walletChainId != null && opts.walletChainId !== p.chainId)
        return end({ step: "error", at: "simulating", error: { code: "WRONG_NETWORK", message: ERROR_MESSAGES.WRONG_NETWORK }, txHash: null });
    try {
        await ports.simulate(p);
    } catch (err) {
        return end({ step: "error", at: "simulating", error: describeWalletError(err), txHash: null });
    }

    emit({ step: "awaiting_signature" });
    let txHash: Hex;
    try {
        txHash = await ports.send(p);
    } catch (err) {
        return end({ step: "error", at: "awaiting_signature", error: describeWalletError(err), txHash: null });
    }

    emit({ step: "confirming", txHash });
    const confirmed = await ports.confirm({ evidenceId: p.evidenceId, txHash });
    if (!confirmed.ok) return end({ step: "error", at: "confirming", error: confirmed.error, txHash });
    if (confirmed.data.status !== "anchored")
        return end({ step: "error", at: "confirming", error: { code: "TX_REVERTED", message: ERROR_MESSAGES.TX_REVERTED }, txHash });
    return end({ step: "done", txHash, evidenceHash: p.evidenceHash });
}

/** Ports backed by the injected wallet (viem custom EIP-1193 transport) and the JSON API. */
export function createWalletPorts(o: { provider: Eip1193Provider; account: Hex; fetchImpl?: typeof fetch }): OwnerActionPorts {
    const chainOf = (p: PreparedAction) => {
        const chain = chainFor(p.chainId);
        if (!chain) throw Object.assign(new Error(`unsupported chain ${p.chainId}`), { code: "WRONG_NETWORK" });
        return chain;
    };
    const transport = custom(o.provider);
    /** Wallet/contract failures leave the port as UI errors ({ code, message }). */
    const mapped = async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
            return await fn();
        } catch (err) {
            throw Object.assign(new Error(), describeWalletError(err));
        }
    };
    return {
        prepare: (body) => postJson<PreparedAction>("/api/owner-actions/prepare", body, o.fetchImpl),
        simulate: (p) =>
            mapped(async () => {
                const call = toContractCall(p.call);
                const client = createPublicClient({ chain: chainOf(p), transport });
                await client.simulateContract({ address: p.vault, abi: policyVaultAbi, functionName: call.functionName, args: call.args, account: o.account } as never);
            }),
        send: (p) =>
            mapped(async () => {
                const call = toContractCall(p.call);
                const chain = chainOf(p);
                const wallet = createWalletClient({ chain, transport });
                return wallet.writeContract({ address: p.vault, abi: policyVaultAbi, functionName: call.functionName, args: call.args, account: o.account, chain } as never);
            }),
        confirm: (i) => postJson<ConfirmResponse>("/api/owner-actions/confirm", i, o.fetchImpl),
    };
}
