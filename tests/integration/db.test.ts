import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/adapters/db/sqlite";
import { createEvidenceRepo } from "@/adapters/db/evidenceRepo";
import { createKilnCallRepo } from "@/adapters/db/kilnCallRepo";
import { createSpendRequestRepo } from "@/adapters/db/spendRequestRepo";
import { AppError } from "@/core/errors";
import type { KilnCallInsert, SpendRequestRow } from "@/core/ports";

const VAULT = "0x00000000000000000000000000000000000000AA" as const;
const OTHER_VAULT = "0x00000000000000000000000000000000000000BB" as const;
const REQ = `0x${"11".repeat(32)}` as const;
const HASH_A = `0x${"a1".repeat(32)}` as const;
const HASH_B = `0x${"b2".repeat(32)}` as const;

const tmpDirs: string[] = [];
function tmpFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gwdc-db-"));
    tmpDirs.push(dir);
    return path.join(dir, "app.sqlite");
}
const open: Database.Database[] = [];
function db(p = ":memory:") {
    const d = openDatabase(p);
    open.push(d);
    return d;
}
afterEach(() => {
    while (open.length) open.pop()?.close();
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const evidence = (over: Partial<Parameters<ReturnType<typeof createEvidenceRepo>["insert"]>[0]> = {}) => ({
    evidenceId: "ev-1",
    kind: "spend_request",
    chainId: 31337,
    vault: VAULT,
    requestId: REQ,
    packageJson: '{"kind":"spend_request"}',
    evidenceHash: HASH_A,
    createdAt: "2026-09-28T00:00:00.000Z",
    ...over,
});

const kilnCall = (over: Partial<KilnCallInsert> = {}): KilnCallInsert => ({
    callId: "call-1",
    flow: "intent_judge",
    provider: "fake",
    model: "qwen3-32b",
    httpStatus: 200,
    finishReason: "tool_calls",
    attempts: 1,
    latencyMs: 12,
    promptTokens: 300,
    completionTokens: 90,
    reasoningTokens: null,
    totalTokens: 390,
    cachedTokens: null,
    costUsd: "0.0002",
    generationId: "gen-1",
    thinkingMode: "default",
    createdAt: "2026-09-28T00:00:00.000Z",
    chainId: 31337,
    vault: VAULT,
    requestId: REQ,
    status: "tool_call",
    errorCode: null,
    rawArguments: '{"fits_purpose":true}',
    rawContent: null,
    ...over,
});

const spendRow = (over: Partial<SpendRequestRow> = {}): SpendRequestRow => ({
    requestId: REQ,
    evidenceId: "ev-1",
    chainId: 31337,
    vault: VAULT,
    flow: "intent_judge",
    merchantId: "daiso",
    amount: 30_000n,
    fee: 300n,
    precheckVerdict: "pass",
    precheckReason: null,
    judgmentStatus: "match",
    txHash: null,
    outcome: null,
    onchainReason: null,
    pendingFlags: null,
    createdAt: "2026-09-28T00:00:00.000Z",
    ...over,
});

describe("openDatabase — schema v1 (Architecture 6)", () => {
    it("creates the five tables, sets user_version 1 and WAL on a file database", () => {
        const d = db(tmpFile());
        const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all();
        expect(tables).toEqual(["chain_events", "evidence", "kiln_calls", "spend_requests", "sync_state"]);
        expect(d.pragma("user_version", { simple: true })).toBe(1);
        expect(d.pragma("journal_mode", { simple: true })).toBe("wal");
    });

    it("re-opens an existing v1 file without losing rows", () => {
        const file = tmpFile();
        const first = openDatabase(file);
        createEvidenceRepo(first).insert(evidence());
        first.close();
        expect(createEvidenceRepo(db(file)).findById("ev-1")?.evidenceHash).toBe(HASH_A);
    });

    it("refuses to start on a different user_version and says how to recover", () => {
        const file = tmpFile();
        const raw = new Database(file);
        raw.pragma("user_version = 2");
        raw.close();
        let err: unknown;
        try {
            db(file);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("DB_VERSION_MISMATCH");
        expect((err as AppError).message).toContain("delete data.local/app.sqlite");
    });
});

describe("EvidenceRepo", () => {
    it("stores the canonical string verbatim and finds it by hash, id and request id", () => {
        const repo = createEvidenceRepo(db());
        repo.insert(evidence());
        const row = repo.findByHash(HASH_A);
        expect(row).toMatchObject({ evidenceId: "ev-1", packageJson: '{"kind":"spend_request"}', anchor: null, requestId: REQ });
        expect(repo.findById("ev-1")?.evidenceHash).toBe(HASH_A);
        expect(repo.listByRequestId(REQ).map((r) => r.evidenceId)).toEqual(["ev-1"]);
        expect(repo.findByHash(HASH_B)).toBeNull();
        expect(repo.findById("missing")).toBeNull();
    });

    it("sets the anchor outside the hashed package", () => {
        const repo = createEvidenceRepo(db());
        repo.insert(evidence());
        const anchor = { txHash: HASH_B, blockNumber: "12", logIndex: 0, event: "SpendBlocked", args: { reason: 6, amount: "1000" } };
        repo.setAnchor(HASH_A, anchor);
        const row = repo.findByHash(HASH_A)!;
        expect(row.anchor).toEqual(anchor);
        expect(row.anchoredAt).not.toBeNull();
        expect(row.packageJson).toBe('{"kind":"spend_request"}');
    });

    it("keeps deployments apart: listByVault filters by (chain_id, vault)", () => {
        const repo = createEvidenceRepo(db());
        repo.insert(evidence());
        repo.insert(evidence({ evidenceId: "ev-2", evidenceHash: HASH_B, vault: OTHER_VAULT }));
        expect(repo.listByVault(31337, VAULT).map((r) => r.evidenceId)).toEqual(["ev-1"]);
        expect(repo.listByVault(84532, VAULT)).toEqual([]);
    });

    it("rejects a second row with the same evidence hash and an unknown kind", () => {
        const repo = createEvidenceRepo(db());
        repo.insert(evidence());
        expect(() => repo.insert(evidence({ evidenceId: "ev-2" }))).toThrow(/UNIQUE/);
        expect(() => repo.insert(evidence({ evidenceId: "ev-3", evidenceHash: HASH_B, kind: "hack" }))).toThrow(/CHECK/);
    });

    it("binds parameters: SQL in a value is stored as text and does not run", () => {
        const d = db();
        const repo = createEvidenceRepo(d);
        const evil = `x'); DROP TABLE evidence; --`;
        repo.insert(evidence({ packageJson: evil }));
        expect(repo.findById("ev-1")?.packageJson).toBe(evil);
        expect(d.prepare("SELECT count(*) FROM evidence").pluck().get()).toBe(1);
    });
});

describe("KilnCallRepo", () => {
    it("round-trips usage, generation id and nullable token fields", () => {
        const repo = createKilnCallRepo(db());
        repo.insert(kilnCall());
        expect(repo.findById("call-1")).toEqual({
            callId: "call-1",
            flow: "intent_judge",
            provider: "fake",
            model: "qwen3-32b",
            httpStatus: 200,
            finishReason: "tool_calls",
            attempts: 1,
            latencyMs: 12,
            promptTokens: 300,
            completionTokens: 90,
            reasoningTokens: null,
            totalTokens: 390,
            cachedTokens: null,
            costUsd: "0.0002",
            generationId: "gen-1",
            thinkingMode: "default",
            createdAt: "2026-09-28T00:00:00.000Z",
        });
        expect(repo.findById("nope")).toBeNull();
    });

    it("cuts raw_content at 4,000 characters and rejects an unknown flow label", () => {
        const d = db();
        const repo = createKilnCallRepo(d);
        repo.insert(kilnCall({ status: "no_tool_call", rawArguments: null, rawContent: "c".repeat(4001) }));
        expect((d.prepare("SELECT raw_content FROM kiln_calls").pluck().get() as string).length).toBe(4000);
        expect(() => repo.insert(kilnCall({ callId: "call-2", flow: "other" as never }))).toThrow(/CHECK/);
    });
});

describe("SpendRequestRepo", () => {
    it("inserts, updates the outcome after the tx and counts by flow per vault", () => {
        const d = db();
        createEvidenceRepo(d).insert(evidence());
        createEvidenceRepo(d).insert(evidence({ evidenceId: "ev-2", evidenceHash: HASH_B, requestId: null }));
        const repo = createSpendRequestRepo(d);
        repo.insert(spendRow());
        repo.insert(spendRow({ requestId: `0x${"22".repeat(32)}`, evidenceId: "ev-2", flow: "rule_block", precheckVerdict: "block", precheckReason: 6, judgmentStatus: null }));
        repo.updateOutcome(REQ, { txHash: HASH_B, outcome: "executed" });

        const row = d.prepare("SELECT * FROM spend_requests WHERE request_id = ?").get(REQ) as Record<string, unknown>;
        expect(row).toMatchObject({ tx_hash: HASH_B, outcome: "executed", amount: "30000", fee: "300", onchain_reason: null });
        expect(repo.countByFlow(31337, VAULT)).toEqual([
            { flow: "intent_judge", n: 1 },
            { flow: "rule_block", n: 1 },
        ]);
        expect(repo.countByFlow(31337, OTHER_VAULT)).toEqual([]);
    });

    it("refuses a spend row whose evidence does not exist (foreign key)", () => {
        const repo = createSpendRequestRepo(db());
        expect(() => repo.insert(spendRow({ evidenceId: "missing" }))).toThrow(/FOREIGN KEY/);
    });
});
