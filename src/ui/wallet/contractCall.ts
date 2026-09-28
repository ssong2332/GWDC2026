import { BaseError, ChainMismatchError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import type { OwnerCallDto } from "@/app/api/_lib/dto";
import type { Hex } from "@/core/domain/types";
import type { ApiError } from "../apiClient";
import { ERROR_MESSAGES } from "../errorMessages";

// Owner calls as the server prepared them (amounts as decimal strings) → viem arguments, and wallet/contract errors
// → UI error codes (Architecture 10 서명 흐름: custom errors become readable text before signing; 4001 → "Signature rejected").

export type ContractCall = { functionName: OwnerCallDto["functionName"]; args: readonly unknown[] };

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function bad(message: string): never {
    throw Object.assign(new Error(message), { code: "BAD_RESPONSE" });
}
const hash = (v: unknown): Hex => (typeof v === "string" && HASH_RE.test(v) ? (v as Hex) : bad("malformed 32-byte argument"));
const uint = (v: unknown): bigint => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : bad("malformed integer argument"));
const small = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : bad("malformed limit argument"));

export function toContractCall(dto: OwnerCallDto): ContractCall {
    const a = Array.isArray(dto.args) ? dto.args : bad("missing arguments");
    const arity = (n: number) => (a.length === n ? undefined : bad(`${dto.functionName} takes ${n} arguments`));
    switch (dto.functionName) {
        case "setPolicy": {
            arity(2);
            const p = a[0] as Record<string, unknown>;
            if (typeof p !== "object" || p === null) bad("malformed policy argument");
            const merchants = Array.isArray(p.merchants) && p.merchants.every((m) => typeof m === "string" && ADDRESS_RE.test(m)) ? (p.merchants as Hex[]) : bad("malformed merchants");
            return {
                functionName: "setPolicy",
                args: [
                    {
                        budget: uint(p.budget),
                        approvalThreshold: uint(p.approvalThreshold),
                        expiresAt: uint(p.expiresAt),
                        maxPerMinute: small(p.maxPerMinute),
                        maxPerDay: small(p.maxPerDay),
                        merchants,
                    },
                    hash(a[1]),
                ],
            };
        }
        case "approve":
        case "reject":
            arity(2);
            return { functionName: dto.functionName, args: [hash(a[0]), hash(a[1])] };
        case "pause":
            arity(1);
            return { functionName: "pause", args: [hash(a[0])] };
        default:
            return bad(`unexpected owner call ${String((dto as { functionName: unknown }).functionName)}`);
    }
}

const POLICY_FIELDS = ["", "budget", "approvalThreshold", "expiresAt", "maxPerMinute", "maxPerDay", "merchants"];
const KNOWN_REVERTS = new Set(["NotOwner", "PendingExists", "PendingNotFound", "VaultIsPaused", "PolicyExpired", "AlreadyPaused", "NotPaused", "InvalidPolicy"]);
const screaming = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();

function firstLine(err: unknown): string {
    const short = (err as { shortMessage?: unknown }).shortMessage;
    const text = typeof short === "string" ? short : err instanceof Error ? err.message : String(err);
    return text.split("\n")[0];
}

export function describeWalletError(err: unknown): ApiError {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && Object.hasOwn(ERROR_MESSAGES, code)) return { code, message: firstLine(err) };
    if (err instanceof BaseError) {
        if (err.walk((e) => e instanceof UserRejectedRequestError)) return { code: "SIGNATURE_REJECTED", message: ERROR_MESSAGES.SIGNATURE_REJECTED };
        if (err.walk((e) => e instanceof ChainMismatchError)) return { code: "WRONG_NETWORK", message: firstLine(err) };
        const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
        const name = revert?.data?.errorName;
        if (revert && name && KNOWN_REVERTS.has(name)) {
            if (name === "InvalidPolicy") {
                const field = POLICY_FIELDS[Number(revert.data?.args?.[0])] ?? "unknown";
                return { code: "CONTRACT_INVALID_POLICY", message: `PolicyVault rejected the policy field: ${field}` };
            }
            const c = `CONTRACT_${screaming(name)}`;
            return { code: c, message: ERROR_MESSAGES[c] };
        }
        if (revert) return { code: "CONTRACT_REVERTED", message: firstLine(revert) };
    }
    if (code === 4001) return { code: "SIGNATURE_REJECTED", message: ERROR_MESSAGES.SIGNATURE_REJECTED };
    return { code: "WALLET_ERROR", message: firstLine(err) };
}
