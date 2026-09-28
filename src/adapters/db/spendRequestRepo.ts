import type Database from "better-sqlite3";
import type { SpendRequestRepo, SpendRequestRow } from "@/core/ports";

// Only these columns may change after insert; the column names come from this fixed map, values are bound.
const UPDATABLE = {
    txHash: "tx_hash",
    outcome: "outcome",
    onchainReason: "onchain_reason",
    pendingFlags: "pending_flags",
} as const;

export function createSpendRequestRepo(db: Database.Database): SpendRequestRepo {
    const insert = db.prepare(
        `INSERT INTO spend_requests (request_id, evidence_id, chain_id, vault, flow, merchant_id, amount, fee, precheck_verdict,
           precheck_reason, judgment_status, tx_hash, outcome, onchain_reason, pending_flags, created_at)
         VALUES (@requestId, @evidenceId, @chainId, @vault, @flow, @merchantId, @amount, @fee, @precheckVerdict,
           @precheckReason, @judgmentStatus, @txHash, @outcome, @onchainReason, @pendingFlags, @createdAt)`,
    );
    const count = db.prepare(
        "SELECT flow, count(*) AS n FROM spend_requests WHERE chain_id = ? AND vault = ? GROUP BY flow ORDER BY flow",
    );
    return {
        insert: (r: SpendRequestRow) => void insert.run({ ...r, amount: r.amount.toString(), fee: r.fee.toString() }),
        updateOutcome: (requestId, o) => {
            const keys = (Object.keys(UPDATABLE) as (keyof typeof UPDATABLE)[]).filter((k) => o[k] !== undefined);
            if (keys.length === 0) return;
            const sets = keys.map((k) => `${UPDATABLE[k]} = @${k}`).join(", ");
            const values = Object.fromEntries(keys.map((k) => [k, o[k]]));
            db.prepare(`UPDATE spend_requests SET ${sets} WHERE request_id = @requestId`).run({ ...values, requestId });
        },
        countByFlow: (chainId, vault) => count.all(chainId, vault) as { flow: string; n: number }[],
    };
}
