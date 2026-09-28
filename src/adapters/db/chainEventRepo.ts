import type Database from "better-sqlite3";
import type { Hex } from "@/core/domain/types";
import type { ChainEventRepo, DecodedVaultEvent } from "@/core/ports";

// Decoded vault event cache (ADR-0004, D-33). args_json encodes bigint as {"__bigint":"<decimal>"} and decoding
// restores it, so callers get back exactly what the reader produced.

const BIGINT_TAG = "__bigint";

function encodeArgs(args: Record<string, unknown>): string {
    return JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? { [BIGINT_TAG]: v.toString() } : v));
}

function decodeArgs(json: string): Record<string, unknown> {
    return JSON.parse(json, (_k, v) => {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            const keys = Object.keys(v);
            if (keys.length === 1 && keys[0] === BIGINT_TAG && typeof v[BIGINT_TAG] === "string") return BigInt(v[BIGINT_TAG]);
        }
        return v;
    });
}

type Row = {
    tx_hash: string;
    log_index: number;
    block_number: string;
    block_timestamp: number;
    event_name: string;
    args_json: string;
};

const toEvent = (r: Row): DecodedVaultEvent => ({
    name: r.event_name,
    txHash: r.tx_hash as Hex,
    logIndex: r.log_index,
    blockNumber: BigInt(r.block_number),
    blockTimestamp: r.block_timestamp,
    args: decodeArgs(r.args_json),
});

const hexArg = (v: unknown): string | null => (typeof v === "string" && v.startsWith("0x") ? v : null);

export function createChainEventRepo(db: Database.Database): ChainEventRepo {
    const upsert = db.prepare(
        `INSERT INTO chain_events (chain_id, vault, tx_hash, log_index, block_number, block_timestamp, event_name, request_id, evidence_hash, args_json)
         VALUES (@chainId, @vault, @txHash, @logIndex, @blockNumber, @blockTimestamp, @name, @requestId, @evidenceHash, @argsJson)
         ON CONFLICT (chain_id, tx_hash, log_index) DO UPDATE SET
           vault = excluded.vault, block_number = excluded.block_number, block_timestamp = excluded.block_timestamp,
           event_name = excluded.event_name, request_id = excluded.request_id, evidence_hash = excluded.evidence_hash,
           args_json = excluded.args_json`,
    );
    // block_number is TEXT (decimal); order numerically.
    const list = db.prepare(
        "SELECT * FROM chain_events WHERE chain_id = ? AND vault = ? ORDER BY CAST(block_number AS INTEGER), log_index",
    );
    const byTx = db.prepare("SELECT * FROM chain_events WHERE tx_hash = ? ORDER BY log_index");
    const getSync = db.prepare("SELECT last_block FROM sync_state WHERE chain_id = ? AND vault = ?").pluck();
    const setSync = db.prepare(
        `INSERT INTO sync_state (chain_id, vault, last_block) VALUES (?, ?, ?)
         ON CONFLICT (chain_id, vault) DO UPDATE SET last_block = excluded.last_block`,
    );
    const upsertAll = db.transaction((events: DecodedVaultEvent[], chainId: number, vault: Hex) => {
        for (const e of events)
            upsert.run({
                chainId,
                vault,
                txHash: e.txHash,
                logIndex: e.logIndex,
                blockNumber: e.blockNumber.toString(),
                blockTimestamp: e.blockTimestamp,
                name: e.name,
                requestId: hexArg(e.args.requestId),
                evidenceHash: hexArg(e.args.evidenceHash),
                argsJson: encodeArgs(e.args),
            });
    });

    return {
        upsertMany: (events, chainId, vault) => upsertAll(events, chainId, vault),
        list: (chainId, vault) => (list.all(chainId, vault) as Row[]).map(toEvent),
        findByTx: (txHash) => (byTx.all(txHash) as Row[]).map(toEvent),
        getSyncBlock: (chainId, vault) => {
            const v = getSync.get(chainId, vault) as string | undefined;
            return v === undefined ? null : BigInt(v);
        },
        setSyncBlock: (chainId, vault, b) => void setSync.run(chainId, vault, b.toString()),
    };
}
