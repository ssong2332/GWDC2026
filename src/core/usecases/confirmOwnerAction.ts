import type { Hex } from "@/core/domain/types";
import { AppError } from "@/core/errors";
import type { DecodedVaultEvent } from "@/core/ports";
import { syncChainEvents, type SyncDeps } from "./syncChainEvents";

// Owner action confirmation (Architecture 데이터 흐름 A-5 / C, D-23): the browser reports only the tx hash. The server
// waits for the receipt itself, then syncs vault events; the evidence is anchored by the event carrying its hash —
// never by what the browser says.

export type ConfirmDeps = SyncDeps & { timeoutMs: number; pollMs: number; sleep?: (ms: number) => Promise<void> };

export type ConfirmResult = { status: "anchored" | "reverted"; events: DecodedVaultEvent[] };

const OWNER_KINDS = new Set(["policy_set", "approval", "rejection", "pause", "unpause"]);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function confirmOwnerAction(d: ConfirmDeps, i: { evidenceId: string; txHash: Hex }): Promise<ConfirmResult> {
    const row = d.evidence.findById(i.evidenceId);
    if (!row || !OWNER_KINDS.has(row.kind)) throw new AppError("NOT_FOUND", `no owner-action evidence ${i.evidenceId}`);
    const sleep = d.sleep ?? defaultSleep;
    const deadline = Date.now() + d.timeoutMs;

    let receipt = await d.reader.getReceiptEvents(i.txHash);
    while (receipt === null) {
        if (Date.now() >= deadline) throw new AppError("NOT_FOUND", `transaction ${i.txHash} is not mined yet — check the wallet and retry`);
        await sleep(d.pollMs);
        receipt = await d.reader.getReceiptEvents(i.txHash);
    }
    if (receipt.status !== "success") return { status: "reverted", events: [] };

    // The RPC's latest block can lag the receipt (load-balanced public RPCs): sync until the cursor covers it.
    for (;;) {
        const { toBlock } = await syncChainEvents(d);
        if (toBlock >= receipt.blockNumber || Date.now() >= deadline) break;
        await sleep(d.pollMs);
    }
    const anchor = d.evidence.findById(i.evidenceId)?.anchor ?? null;
    if (anchor === null || anchor.txHash.toLowerCase() !== i.txHash.toLowerCase())
        throw new AppError("VALIDATION_FAILED", "the transaction does not carry this evidence hash");
    return { status: "anchored", events: receipt.events };
}
