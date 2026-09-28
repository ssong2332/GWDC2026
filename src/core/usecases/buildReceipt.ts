import { getAddress } from "viem";
import type { SpendRequestEvidence } from "@/core/domain/evidence";
import type { Hex, IntentJudgment, MerchantEntry } from "@/core/domain/types";
import type { ChainEventRepo, EvidenceRepo } from "@/core/ports";

// F-10 receipt for one executed payment: amount, fee, merchant, tx hash, evidence hash, Kiln judgment summary.
// Built from the vault event cache (the caller syncs first) and the local evidence. Not executed → null.

export type JudgmentSummary = {
    /** `not_judged`: rule pre-check path, no Kiln call. `no_local_evidence`: the request evidence is not in this database. */
    status: IntentJudgment["status"] | "not_judged" | "no_local_evidence";
    reason: string | null;
    provider: "kiln" | "fake" | null;
};

export type Receipt = {
    requestId: Hex;
    amount: bigint;
    fee: bigint;
    merchant: { id: string | null; name: string; address: Hex };
    txHash: Hex;
    evidenceHash: Hex;
    judgmentSummary: JudgmentSummary;
    viaApproval: boolean;
    approver: Hex | null;
    blockTimestamp: number;
};

export type BuildReceiptDeps = { chainId: number; vault: Hex; chainEvents: ChainEventRepo; evidence: EvidenceRepo; merchants: MerchantEntry[] };

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

function summary(d: BuildReceiptDeps, requestId: Hex): JudgmentSummary {
    const row = d.evidence.listByRequestId(requestId).find((r) => r.kind === "spend_request");
    if (!row) return { status: "no_local_evidence", reason: null, provider: null };
    const pkg = JSON.parse(row.packageJson) as SpendRequestEvidence;
    if (!pkg.judgment) return { status: "not_judged", reason: null, provider: null };
    return { status: pkg.judgment.status, reason: pkg.judgment.reason, provider: pkg.judgment.kiln.provider };
}

export async function buildReceipt(d: BuildReceiptDeps, requestId: Hex): Promise<Receipt | null> {
    const events = d.chainEvents.list(d.chainId, d.vault);
    const executed = events.find((e) => e.name === "SpendExecuted" && same(e.args.requestId, requestId));
    if (!executed) return null;
    const approved = events.find((e) => e.name === "Approved" && same(e.args.requestId, requestId) && e.txHash === executed.txHash);
    const address = getAddress(String(executed.args.merchant)) as Hex;
    const entry = d.merchants.find((m) => same(m.address, address));
    return {
        requestId: executed.args.requestId as Hex,
        amount: executed.args.amount as bigint,
        fee: executed.args.fee as bigint,
        merchant: { id: entry?.id ?? null, name: entry?.displayName ?? address, address },
        txHash: executed.txHash,
        evidenceHash: executed.args.evidenceHash as Hex,
        judgmentSummary: summary(d, requestId),
        viaApproval: executed.args.viaApproval === true,
        approver: approved ? (getAddress(String(approved.args.approver)) as Hex) : null,
        blockTimestamp: executed.blockTimestamp,
    };
}
