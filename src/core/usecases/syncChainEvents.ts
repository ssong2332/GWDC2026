import type { Anchor } from "@/core/domain/evidence";
import type { Hex } from "@/core/domain/types";
import type { ChainEventRepo, DecodedVaultEvent, EvidenceRepo, VaultReader } from "@/core/ports";

export type PullDeps = { reader: VaultReader; chainEvents: ChainEventRepo; chainId: number; vault: Hex; deployBlock: bigint };
export type SyncDeps = PullDeps & { evidence: EvidenceRepo };

/**
 * Incremental event collection (ADR-0004): from = (cursor ?? deployBlock − 1) + 1, to = latest block.
 * Upserts are idempotent, so a cursor moved backwards by a concurrent caller only causes a re-scan.
 */
export async function pullNewEvents(d: PullDeps): Promise<{ newEvents: number; toBlock: bigint }> {
    const from = (d.chainEvents.getSyncBlock(d.chainId, d.vault) ?? d.deployBlock - 1n) + 1n;
    const to = await d.reader.latestBlock();
    if (from > to) return { newEvents: 0, toBlock: to };
    const events = await d.reader.getLogs(from, to);
    d.chainEvents.upsertMany(events, d.chainId, d.vault);
    d.chainEvents.setSyncBlock(d.chainId, d.vault, to);
    return { newEvents: events.length, toBlock: to };
}

/** Anchor args as JSON-safe values (bigint → decimal string, arrays → string[]). */
export function toAnchor(e: DecodedVaultEvent): NonNullable<Anchor> {
    const args: Record<string, string | number | boolean | string[]> = {};
    for (const [k, v] of Object.entries(e.args)) {
        if (typeof v === "bigint") args[k] = v.toString();
        else if (Array.isArray(v)) args[k] = v.map(String);
        else if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") args[k] = v;
        else args[k] = String(v);
    }
    return { txHash: e.txHash, blockNumber: e.blockNumber.toString(), logIndex: e.logIndex, event: e.name, args };
}

/**
 * pullNewEvents + anchor linking (F-11): every cached event whose evidenceHash matches a local evidence row
 * without an anchor anchors that row. Existing anchors are never moved — a SpendExecuted(viaApproval) carries
 * the original request's hash, which stays anchored to its SpendPending.
 */
export async function syncChainEvents(d: SyncDeps): Promise<{ newEvents: number; anchored: number; toBlock: bigint }> {
    const pulled = await pullNewEvents(d);
    let anchored = 0;
    for (const e of d.chainEvents.list(d.chainId, d.vault)) {
        const hash = e.args.evidenceHash;
        if (typeof hash !== "string") continue;
        const row = d.evidence.findByHash(hash as Hex);
        if (!row || row.anchor !== null) continue;
        d.evidence.setAnchor(hash as Hex, toAnchor(e));
        anchored++;
    }
    return { ...pulled, anchored };
}
