import { getAddress } from "viem";
import type { SpendRequestEvidence } from "@/core/domain/evidence";
import type { Hex, MerchantEntry } from "@/core/domain/types";
import type { ChainEventRepo, DecodedVaultEvent, EvidenceRepo } from "@/core/ports";

// Dashboard activity list (Architecture 9 `GET /api/vault/activity`, PRD 화면 ②) from the vault event cache (ADR-0004).
// The caller runs syncChainEvents first; this only reads the cache and the local evidence.

export type ActivityKind = "executed" | "blocked" | "pending" | "approved" | "rejected" | "paused" | "unpaused" | "policy_set";

export type ActivityItem = {
    requestId: Hex | null;
    kind: ActivityKind;
    merchantId: string | null;
    amount: bigint | null;
    fee: bigint | null;
    reason: number | null;
    flags: number | null;
    txHash: Hex;
    blockTimestamp: number;
    judgmentStatus: string | null;
};

export type ListActivityDeps = { chainId: number; vault: Hex; chainEvents: ChainEventRepo; evidence: EvidenceRepo; merchants: MerchantEntry[] };

const KIND_OF: Record<string, ActivityKind> = {
    SpendExecuted: "executed",
    SpendBlocked: "blocked",
    SpendPending: "pending",
    Approved: "approved",
    Rejected: "rejected",
    VaultPaused: "paused",
    VaultUnpaused: "unpaused",
    PolicySet: "policy_set",
};

const key = (v: unknown) => String(v).toLowerCase();
const big = (v: unknown) => (typeof v === "bigint" ? v : null);

export function listActivity(d: ListActivityDeps): ActivityItem[] {
    const events = d.chainEvents.list(d.chainId, d.vault);
    const merchantIdByAddress = new Map(d.merchants.map((m) => [key(getAddress(m.address)), m.id]));
    const judgmentByRequest = new Map<string, string | null>();
    for (const row of d.evidence.listByVault(d.chainId, d.vault)) {
        if (row.kind !== "spend_request" || row.requestId === null) continue;
        const pkg = JSON.parse(row.packageJson) as SpendRequestEvidence;
        judgmentByRequest.set(key(row.requestId), pkg.judgment?.status ?? null);
    }
    // Approved/Rejected carry only the request id; merchant and amount come from the request's SpendPending.
    const pendingByRequest = new Map<string, DecodedVaultEvent>();
    for (const e of events) if (e.name === "SpendPending") pendingByRequest.set(key(e.args.requestId), e);

    const items: ActivityItem[] = [];
    for (const e of events) {
        const kind = KIND_OF[e.name];
        if (!kind) continue;
        const requestId = typeof e.args.requestId === "string" ? (e.args.requestId as Hex) : null;
        const source = kind === "approved" || kind === "rejected" ? (requestId ? pendingByRequest.get(key(requestId)) : undefined) : e;
        const merchant = source?.args.merchant;
        items.push({
            requestId,
            kind,
            merchantId: merchant === undefined ? null : (merchantIdByAddress.get(key(merchant)) ?? null),
            amount: big(source?.args.amount),
            fee: big(source?.args.fee),
            reason: kind === "blocked" ? Number(e.args.reason) : null,
            flags: kind === "pending" ? Number(e.args.flags) : null,
            txHash: e.txHash,
            blockTimestamp: e.blockTimestamp,
            judgmentStatus: requestId ? (judgmentByRequest.get(key(requestId)) ?? null) : null,
        });
    }
    return items;
}
