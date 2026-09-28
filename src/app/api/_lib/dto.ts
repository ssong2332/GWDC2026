import { getAddress } from "viem";
import { z } from "zod";
import { API_LIMITS } from "@/config/constants";
import type { Hex, PolicyCandidate, VaultStateSnapshot } from "@/core/domain/types";
import type { ActivityItem } from "@/core/usecases/listActivity";
import type { Receipt } from "@/core/usecases/buildReceipt";
import type { EfficiencyReport } from "@/core/domain/efficiency";
import type { AuditResult } from "@/core/usecases/verifyTx";

// HTTP DTOs (Architecture 9): request schemas for external input, and response shapes with bigint → decimal string.
// The UI imports the response types only (type imports — nothing from here is bundled into the browser).

/** bigint → decimal string, recursively (JSON-safe copy; the input is not modified). */
export function toJsonSafe(value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return value.map(toJsonSafe);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
    return value;
}

export type Jsonify<T> = T extends bigint
    ? string
    : T extends readonly (infer U)[]
      ? Jsonify<U>[]
      : T extends object
        ? { [K in keyof T]: Jsonify<T[K]> }
        : T;

const address = z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address")
    .transform((a) => getAddress(a) as Hex);
const bytes32 = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x + 64 hex characters")
    .transform((h) => h as Hex);
const decimal = z
    .string()
    .regex(new RegExp(`^\\d{1,${API_LIMITS.decimalDigitsMax}}$`), "must be a non-negative integer as a decimal string")
    .transform((s) => BigInt(s));

export const parseBodySchema = z.object({ delegationText: z.string() });

const finalPolicySchema = z.object({
    budget: decimal,
    approvalThreshold: decimal,
    expiresAt: z.number().int().min(0),
    maxPerMinute: z.number().int(),
    maxPerDay: z.number().int(),
    merchantIds: z.array(z.string().max(API_LIMITS.idMax)).max(API_LIMITS.listMax),
    purpose: z.string(),
});

// `unpause` is deliberately absent: resuming is outside the screens (Architecture 데이터 흐름 C — CLI only).
export const prepareBodySchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("policy_set"),
        owner: address,
        parseCallId: z.string().min(1).max(API_LIMITS.idMax).nullable(),
        delegationText: z.string(),
        final: finalPolicySchema,
        expiresAtSource: z.enum(["kiln", "owner"]),
        ownerEdits: z.array(z.string().max(API_LIMITS.idMax)).max(API_LIMITS.listMax),
    }),
    z.object({ kind: z.enum(["approval", "rejection"]), owner: address, requestId: bytes32 }),
    z.object({ kind: z.literal("pause"), owner: address, note: z.string().default("") }),
]);

export const confirmBodySchema = z.object({ evidenceId: z.string().min(1).max(API_LIMITS.idMax), txHash: bytes32 });

export const requestIdSchema = bytes32;
export const txHashSchema = bytes32;

export type KilnUsageDto = {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number | null;
    totalTokens: number;
    costUsd: string | null;
    generationId: string | null;
    provider: "kiln" | "fake";
};

export type ParsePolicyResponse = { parseCallId: string; candidate: Jsonify<PolicyCandidate>; warnings: string[]; usage: KilnUsageDto | null };

export type OwnerCallDto = { functionName: "setPolicy" | "approve" | "reject" | "pause"; args: unknown[] };
export type PrepareResponse = { evidenceId: string; evidenceHash: Hex; call: OwnerCallDto; vault: Hex; chainId: number };

export type VaultEventDto = { name: string; txHash: Hex; logIndex: number; blockNumber: string; blockTimestamp: number; args: Record<string, unknown> };
export type ConfirmResponse = { status: "anchored" | "reverted"; events: VaultEventDto[] };

export type VaultStateDto = Jsonify<Omit<VaultStateSnapshot, "chainId" | "vault">>;
export type VaultStateResponse = {
    chainId: number;
    vault: Hex;
    token: Hex;
    owner: Hex;
    agent: Hex;
    feeBps: number;
    explorerTxUrl: string | null;
    state: VaultStateDto;
};

export type ActivityItemDto = Jsonify<ActivityItem>;
export type ActivityResponse = { items: ActivityItemDto[] };

export type ReceiptDto = Jsonify<Receipt>;
export type ReceiptResponse = { receipt: ReceiptDto };

/** GET /api/audit/[txHash] — event args with bigint → decimal string. */
export type AuditResponse = { result: Jsonify<AuditResult> };
export type EfficiencyResponse = { report: EfficiencyReport };
