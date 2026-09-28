import type Database from "better-sqlite3";
import type { Anchor } from "@/core/domain/evidence";
import type { Hex } from "@/core/domain/types";
import type { EvidenceRepo, EvidenceRow } from "@/core/ports";

type Row = {
    evidence_id: string;
    kind: string;
    chain_id: number;
    vault: string;
    request_id: string | null;
    package_json: string;
    evidence_hash: string;
    created_at: string;
    anchor_tx_hash: string | null;
    anchor_block: string | null;
    anchor_log_index: number | null;
    anchor_event: string | null;
    anchor_args_json: string | null;
    anchored_at: string | null;
};

function toEvidenceRow(r: Row): EvidenceRow {
    const anchor: Anchor =
        r.anchor_tx_hash === null
            ? null
            : {
                  txHash: r.anchor_tx_hash as Hex,
                  blockNumber: r.anchor_block ?? "",
                  logIndex: r.anchor_log_index ?? 0,
                  event: r.anchor_event ?? "",
                  args: JSON.parse(r.anchor_args_json ?? "{}"),
              };
    return {
        evidenceId: r.evidence_id,
        kind: r.kind,
        chainId: r.chain_id,
        vault: r.vault as Hex,
        requestId: r.request_id as Hex | null,
        packageJson: r.package_json,
        evidenceHash: r.evidence_hash as Hex,
        createdAt: r.created_at,
        anchor,
        anchoredAt: r.anchored_at,
    };
}

export function createEvidenceRepo(db: Database.Database): EvidenceRepo {
    const insert = db.prepare(
        `INSERT INTO evidence (evidence_id, kind, chain_id, vault, request_id, package_json, evidence_hash, created_at)
         VALUES (@evidenceId, @kind, @chainId, @vault, @requestId, @packageJson, @evidenceHash, @createdAt)`,
    );
    const byHash = db.prepare("SELECT * FROM evidence WHERE evidence_hash = ?");
    const byId = db.prepare("SELECT * FROM evidence WHERE evidence_id = ?");
    const byRequest = db.prepare("SELECT * FROM evidence WHERE request_id = ? ORDER BY created_at, rowid");
    const byVault = db.prepare("SELECT * FROM evidence WHERE chain_id = ? AND vault = ? ORDER BY created_at, rowid");
    const anchor = db.prepare(
        `UPDATE evidence SET anchor_tx_hash = @txHash, anchor_block = @blockNumber, anchor_log_index = @logIndex,
         anchor_event = @event, anchor_args_json = @argsJson, anchored_at = @anchoredAt WHERE evidence_hash = @hash`,
    );
    const one = (r: unknown) => (r ? toEvidenceRow(r as Row) : null);
    return {
        insert: (r) => void insert.run(r),
        findByHash: (h) => one(byHash.get(h)),
        findById: (id) => one(byId.get(id)),
        listByRequestId: (id) => (byRequest.all(id) as Row[]).map(toEvidenceRow),
        listByVault: (chainId, vault) => (byVault.all(chainId, vault) as Row[]).map(toEvidenceRow),
        setAnchor: (hash, a) =>
            void anchor.run({
                hash,
                txHash: a.txHash,
                blockNumber: a.blockNumber,
                logIndex: a.logIndex,
                event: a.event,
                argsJson: JSON.stringify(a.args),
                anchoredAt: new Date().toISOString(),
            }),
    };
}
