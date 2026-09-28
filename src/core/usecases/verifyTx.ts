import { z } from "zod";
import { EVIDENCE_EXPORT_SCHEMA } from "@/config/constants";
import { canonicalJson, hashCanonical, type EvidenceExport, type EvidenceExportRecord } from "@/core/domain/evidence";
import { replayPolicy } from "@/core/domain/replay";
import type { Hex } from "@/core/domain/types";
import { AppError } from "@/core/errors";
import { blockReasonLabel } from "@/core/domain/reasons";
import type { ChainEventRepo, DecodedVaultEvent, EvidenceRepo, VaultReader } from "@/core/ports";

// Third-party verification of an exported evidence file (F-12, Architecture 5 checks H/A/F/U/R).
// Input is the JSON file and a public RPC only — no SQLite, no operator. verifyTx (F-13 audit screen) is at the end.

export type VerifyCode = "HASH_MISMATCH" | "TX_NOT_FOUND" | "EVENT_MISMATCH" | "FIELD_MISMATCH" | "UNMATCHED_ONCHAIN_EVENT" | "OUT_OF_POLICY";

export type VerifyProblem = {
    code: VerifyCode;
    detail: string;
    evidenceId?: string;
    txHash?: Hex;
    logIndex?: number;
    event?: string;
};

export type VerifyRow = {
    evidenceId: string;
    kind: string;
    txHash: Hex | null;
    event: string | null;
    recomputedHash: Hex | null;
    onchainHash: Hex | null;
    result: "OK" | "MISMATCH";
    problems: VerifyProblem[];
};

export type VerifyReport = { rows: VerifyRow[]; problems: VerifyProblem[]; mismatches: number; onchainEvents: number };

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const exportSchema = z.object({
    schema: z.literal(EVIDENCE_EXPORT_SCHEMA),
    network: z.enum(["localhost", "baseSepolia"]),
    chainId: z.number().int().positive(),
    vault: hex.length(42),
    token: hex.length(42),
    deployBlock: z.string().regex(/^\d+$/),
    exportedAt: z.string(),
    records: z.array(
        z.object({
            evidenceId: z.string().min(1),
            kind: z.string().min(1),
            evidenceHash: hex.length(66),
            package: z.unknown(),
            anchor: z
                .object({
                    txHash: hex.length(66),
                    blockNumber: z.string(),
                    logIndex: z.number().int().min(0),
                    event: z.string(),
                    args: z.record(z.string(), z.unknown()),
                })
                .nullable(),
        }),
    ),
    kilnCalls: z.array(z.unknown()),
});

/** Validates an export file read from disk (external input). */
export function parseEvidenceExport(json: unknown): EvidenceExport {
    const r = exportSchema.safeParse(json);
    if (!r.success) {
        const i = r.error.issues[0];
        throw new AppError("EXPORT_INVALID", `evidence file ${i.path.join(".") || "root"}: ${i.message}`);
    }
    return r.data as EvidenceExport;
}

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

function recompute(record: EvidenceExportRecord): { hash: Hex | null; problem: VerifyProblem | null } {
    try {
        const hash = hashCanonical(canonicalJson(record.package));
        if (!same(hash, record.evidenceHash))
            return { hash, problem: { code: "HASH_MISMATCH", detail: `recomputed ${hash} != recorded ${record.evidenceHash}` } };
        return { hash, problem: null };
    } catch (err) {
        return { hash: null, problem: { code: "HASH_MISMATCH", detail: `package cannot be canonicalized: ${(err as Error).message}` } };
    }
}

/** Check F for spend records: the anchored event is about this request, merchant and amount. */
function fieldProblems(record: EvidenceExportRecord, event: DecodedVaultEvent): string[] {
    if (record.kind !== "spend_request") return [];
    const pkg = record.package as { requestId?: unknown; request?: { merchantAddress?: unknown; amount?: unknown } };
    const out: string[] = [];
    if (!same(event.args.requestId, pkg.requestId)) out.push("requestId");
    if (!same(event.args.merchant, pkg.request?.merchantAddress)) out.push("merchant");
    if (String(event.args.amount) !== String(pkg.request?.amount)) out.push("amount");
    return out;
}

async function checkRecord(reader: VaultReader, record: EvidenceExportRecord): Promise<VerifyRow> {
    const problems: VerifyProblem[] = [];
    const { hash, problem } = recompute(record);
    if (problem) problems.push(problem);
    const a = record.anchor;
    let onchainHash: Hex | null = null;

    if (a === null) {
        problems.push({ code: "TX_NOT_FOUND", detail: "record has no on-chain anchor" });
    } else {
        const receipt = await reader.getReceiptEvents(a.txHash);
        if (receipt === null) problems.push({ code: "TX_NOT_FOUND", detail: `no receipt for ${a.txHash}` });
        else if (receipt.status !== "success") problems.push({ code: "EVENT_MISMATCH", detail: `tx ${a.txHash} reverted` });
        else {
            const event = receipt.events.find((e) => e.logIndex === a.logIndex);
            if (!event) problems.push({ code: "EVENT_MISMATCH", detail: `no vault log at index ${a.logIndex} in ${a.txHash}` });
            else {
                onchainHash = event.args.evidenceHash as Hex;
                if (event.name !== a.event || hash === null || !same(onchainHash, hash))
                    problems.push({ code: "EVENT_MISMATCH", detail: `${event.name} evidenceHash ${onchainHash} != recomputed ${hash}` });
                const fields = fieldProblems(record, event);
                if (fields.length > 0) problems.push({ code: "FIELD_MISMATCH", detail: `event ${fields.join(", ")} differ from the package` });
            }
        }
    }
    for (const p of problems) Object.assign(p, { evidenceId: record.evidenceId, txHash: a?.txHash, logIndex: a?.logIndex });
    return {
        evidenceId: record.evidenceId,
        kind: record.kind,
        txHash: a?.txHash ?? null,
        event: a?.event ?? null,
        recomputedHash: hash,
        onchainHash,
        result: problems.length === 0 ? "OK" : "MISMATCH",
        problems,
    };
}

/**
 * H: package re-hash == recorded hash. A: anchored tx succeeded and its vault log carries that hash.
 * F: spend events match the package's requestId/merchant/amount. U: every vault event since deployBlock has a record.
 * R: replay shows every SpendExecuted inside the policy. `mismatches` = number of problems (0 = verified).
 */
export async function verifyEvidenceExport(deps: { reader: VaultReader }, file: EvidenceExport): Promise<VerifyReport> {
    const rows: VerifyRow[] = [];
    for (const record of file.records) rows.push(await checkRecord(deps.reader, record));

    const onchain = await deps.reader.getLogs(BigInt(file.deployBlock), await deps.reader.latestBlock());
    const known = new Set(file.records.map((r) => r.evidenceHash.toLowerCase()));
    const unmatched: VerifyProblem[] = onchain
        .filter((e) => !known.has(String(e.args.evidenceHash).toLowerCase()))
        .map((e) => ({
            code: "UNMATCHED_ONCHAIN_EVENT",
            detail: `${e.name} evidenceHash ${String(e.args.evidenceHash)} has no record in the file`,
            txHash: e.txHash,
            logIndex: e.logIndex,
            event: e.name,
        }));
    const outOfPolicy: VerifyProblem[] = replayPolicy(onchain).map((v) => ({
        code: "OUT_OF_POLICY",
        detail: `SpendExecuted ${v.requestId}: ${v.problems.join(", ")}`,
        txHash: v.txHash as Hex,
        logIndex: v.logIndex,
        event: "SpendExecuted",
    }));

    const problems = [...rows.flatMap((r) => r.problems), ...unmatched, ...outOfPolicy];
    return { rows, problems, mismatches: problems.length, onchainEvents: onchain.length };
}

// ---- F-13 audit screen: one tx hash → its vault events, re-hashed local evidence, replay verdict ----

export type AuditItem = {
    event: string;
    args: Record<string, unknown>;
    evidenceKind: string | null;
    package: unknown | null;
    recomputedHash: Hex | null;
    onchainHash: Hex;
    /** null = no local evidence for this hash. */
    hashMatch: boolean | null;
    /** SpendExecuted only: replayed against the vault's event history; null for other events. */
    withinPolicy: boolean | null;
    blockReason: string | null;
    approver: Hex | null;
};
export type AuditResult = { status: "not_found" } | { status: "found"; txHash: Hex; blockNumber: string; items: AuditItem[] };

export type VerifyTxDeps = { reader: VaultReader; evidence: EvidenceRepo; chainEvents: ChainEventRepo; chainId: number; vault: Hex };

function localEvidence(evidence: EvidenceRepo, onchainHash: Hex) {
    const row = evidence.findByHash(onchainHash);
    if (!row) return { evidenceKind: null, package: null, recomputedHash: null, hashMatch: null };
    const pkg: unknown = JSON.parse(row.packageJson);
    let recomputedHash: Hex | null = null;
    try {
        recomputedHash = hashCanonical(canonicalJson(pkg));
    } catch {
        recomputedHash = null;
    }
    return { evidenceKind: row.kind, package: pkg, recomputedHash, hashMatch: recomputedHash !== null && same(recomputedHash, onchainHash) };
}

/**
 * Reads the receipt from the RPC (vault logs only), looks up each log's evidenceHash in the local evidence, re-hashes
 * the stored package and compares it with the on-chain value. SpendExecuted is replayed over the cached vault events
 * (the caller syncs first). No receipt or no vault event in it → not_found ("기록 없음").
 */
export async function verifyTx(deps: VerifyTxDeps, txHash: Hex): Promise<AuditResult> {
    const receipt = await deps.reader.getReceiptEvents(txHash);
    if (receipt === null || receipt.events.length === 0) return { status: "not_found" };
    const violations = replayPolicy(deps.chainEvents.list(deps.chainId, deps.vault));
    const approvedIn = receipt.events.find((e) => e.name === "Approved");
    const items = receipt.events.map((e): AuditItem => {
        const onchainHash = e.args.evidenceHash as Hex;
        const executed = e.name === "SpendExecuted";
        const approver = e.name === "Approved" ? e.args.approver : executed && approvedIn ? approvedIn.args.approver : null;
        return {
            event: e.name,
            args: e.args,
            ...localEvidence(deps.evidence, onchainHash),
            onchainHash,
            withinPolicy: executed ? !violations.some((v) => same(v.txHash, e.txHash) && v.logIndex === e.logIndex) : null,
            blockReason: e.name === "SpendBlocked" ? blockReasonLabel(Number(e.args.reason)) : null,
            approver: approver === null || approver === undefined ? null : (String(approver) as Hex),
        };
    });
    return { status: "found", txHash, blockNumber: receipt.blockNumber.toString(), items };
}
