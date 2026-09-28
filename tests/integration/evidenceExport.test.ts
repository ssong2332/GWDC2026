import type Database from "better-sqlite3";
import { createPublicClient, getAddress, http, type Hex } from "viem";
import { hardhat } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeploymentFile } from "@/adapters/chain/networks";
import { createViemAgentWriter, createViemOwnerWriter, createViemVaultReader } from "@/adapters/chain/viemVault";
import { createChainEventRepo } from "@/adapters/db/chainEventRepo";
import { createEvidenceRepo } from "@/adapters/db/evidenceRepo";
import { createKilnCallRepo } from "@/adapters/db/kilnCallRepo";
import { openDatabase } from "@/adapters/db/sqlite";
import { createSpendRequestRepo } from "@/adapters/db/spendRequestRepo";
import { FakeKilnClient, defaultFakeHandler } from "@/adapters/kiln/fakeKilnClient";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import type { EvidenceExport } from "@/core/domain/evidence";
import { parsePolicy } from "@/core/usecases/parsePolicy";
import { prepareOwnerAction } from "@/core/usecases/prepareOwnerAction";
import { processSpendRequest } from "@/core/usecases/processSpendRequest";
import { syncChainEvents } from "@/core/usecases/syncChainEvents";
import { parseEvidenceExport, verifyEvidenceExport } from "@/core/usecases/verifyTx";
import { buildEvidenceExport } from "../../cli/export-evidence";
import { DEMO_DELEGATION, deployVault, freshMinute, latestTimestamp, publicClient, walletClient } from "./helpers/chain";
import { INTEGRATION_RPC_URL } from "./helpers/rpc";

// F-12 ①②: evidence exported from SQLite re-hashes to the on-chain event hashes, and tampering is reported.
// The verifier sees only the exported JSON and a fresh RPC client — no SQLite, no env.

let db: Database.Database;
let exported: EvidenceExport;
let spends: { executed: Hex; blocked: Hex; pending: Hex };

function verifier(file: EvidenceExport) {
    const client = createPublicClient({ transport: http(INTEGRATION_RPC_URL) });
    return verifyEvidenceExport({ reader: createViemVaultReader({ client, vault: file.vault, chainId: file.chainId }) }, file);
}
const clone = (): EvidenceExport => JSON.parse(JSON.stringify(exported));
const codesOf = (r: Awaited<ReturnType<typeof verifier>>) => r.problems.map((p) => p.code);

beforeAll(async () => {
    await freshMinute();
    db = openDatabase(":memory:");
    const d = await deployVault();
    const vault = getAddress(d.vault);
    const deployment: DeploymentFile = {
        network: "localhost",
        chainId: hardhat.id,
        token: getAddress(d.token),
        vault,
        owner: getAddress(d.owner),
        agent: getAddress(d.agent),
        feeRecipient: getAddress(d.feeRecipient),
        feeBps: 100,
        vaultMint: "1000000",
        deployBlock: Number(d.deployBlock),
    };
    const repos = { evidence: createEvidenceRepo(db), kilnCalls: createKilnCallRepo(db), spendRequests: createSpendRequestRepo(db), chainEvents: createChainEventRepo(db) };
    const kiln = new FakeKilnClient(defaultFakeHandler);
    const clock = { now: () => new Date() };
    const reader = createViemVaultReader({ client: publicClient, vault, chainId: hardhat.id });
    const owner = createViemOwnerWriter({ walletClient, publicClient, vault, account: d.owner, chain: hardhat });
    const ctx = { chainId: hardhat.id, vault, deployBlock: d.deployBlock };
    const ownerDeps = { ...ctx, vaultOwner: getAddress(d.owner), feeBps: 100, ...repos, merchants: MERCHANT_REGISTRY, clock };
    const sync = () => syncChainEvents({ ...ctx, reader, ...repos });

    const parsed = await parsePolicy({ kiln, kilnCalls: repos.kilnCalls, merchants: MERCHANT_REGISTRY, clock, chainId: hardhat.id, vault }, { delegationText: DEMO_DELEGATION });
    if (!parsed.ok) throw new Error("parse failed");
    const prep = await prepareOwnerAction(ownerDeps, {
        kind: "policy_set",
        owner: getAddress(d.owner),
        parseCallId: parsed.parseCallId,
        delegationText: DEMO_DELEGATION,
        final: {
            budget: parsed.candidate.budget,
            approvalThreshold: parsed.candidate.approvalThreshold,
            expiresAt: (await latestTimestamp()) + 7 * 86_400,
            maxPerMinute: 3,
            maxPerDay: 20,
            merchantIds: parsed.candidate.merchantIds,
            purpose: parsed.candidate.purpose,
        },
        expiresAtSource: "owner",
        ownerEdits: ["expiresAt"],
    });
    const [p] = prep.call.args as [{ budget: bigint; approvalThreshold: bigint; expiresAt: bigint; maxPerMinute: number; maxPerDay: number; merchants: Hex[] }];
    await owner.setPolicy({ ...p, expiresAt: Number(p.expiresAt), merchantIds: [], purpose: "" }, prep.evidenceHash);
    await sync();

    const spendDeps = { ...ctx, reader, writer: createViemAgentWriter({ walletClient, publicClient, vault, account: d.agent, chain: hardhat }), kiln, ...repos, merchants: MERCHANT_REGISTRY, clock };
    const a = await processSpendRequest(spendDeps, { merchantId: "daiso", amount: 30_000n, itemDescription: "Balloons and table decorations for the welcome party" });
    const b = await processSpendRequest(spendDeps, { merchantId: "gmarket", amount: 20_000n, itemDescription: "Snacks" });
    const c = await processSpendRequest(spendDeps, { merchantId: "coupang", amount: 60_000n, itemDescription: "Portable speaker for the event" });
    const approval = await prepareOwnerAction(ownerDeps, { kind: "approval", owner: getAddress(d.owner), requestId: c.requestId });
    await owner.approve(c.requestId, approval.evidenceHash);
    const pause = await prepareOwnerAction(ownerDeps, { kind: "pause", owner: getAddress(d.owner), note: "demo pause" });
    await owner.pause(pause.evidenceHash);
    await sync();
    spends = { executed: a.requestId, blocked: b.requestId, pending: c.requestId };
    expect([a.outcome, b.outcome, c.outcome]).toEqual(["executed", "blocked", "pending"]);

    exported = buildEvidenceExport({ deployment, evidence: repos.evidence, kilnCalls: repos.kilnCalls, now: new Date("2026-09-28T12:00:00Z") });
});
afterAll(() => db.close());

describe("buildEvidenceExport (cli/export-evidence.ts)", () => {
    it("writes the Architecture 5 export shape: every evidence row with its package and anchor, plus referenced Kiln calls", () => {
        expect(exported).toMatchObject({ schema: "agent-spend-evidence-export/v1", network: "localhost", chainId: 31337, exportedAt: "2026-09-28T12:00:00.000Z" });
        expect(exported.records.map((r) => r.kind)).toEqual(["policy_set", "spend_request", "spend_request", "spend_request", "approval", "pause"]);
        for (const r of exported.records) expect(r.anchor).not.toBeNull();
        expect(exported.records.find((r) => r.kind === "approval")?.anchor?.event).toBe("Approved");
        // 1 policy parse + 2 intent judgments (daiso, coupang); the rule-blocked gmarket request made no Kiln call.
        expect(exported.kilnCalls.map((k) => k.flow)).toEqual(["policy_parse", "intent_judge", "intent_judge"]);
        expect(exported.kilnCalls[0]).not.toHaveProperty("rawArguments");
        expect(JSON.parse(JSON.stringify(exported))).toEqual(exported); // plain JSON (no bigint)
    });

    it("parseEvidenceExport accepts its own output and rejects a wrong schema tag", () => {
        expect(parseEvidenceExport(clone()).records).toHaveLength(6);
        expect(() => parseEvidenceExport({ ...clone(), schema: "something-else" })).toThrow(/EXPORT_INVALID|schema/);
        expect(() => parseEvidenceExport({ ...clone(), records: "none" })).toThrow();
    });
});

describe("verifyEvidenceExport (cli/verify-evidence.ts core, F-12)", () => {
    it("F-12 ①: untouched export → every record OK, recomputed = on-chain hash, 0 mismatches", async () => {
        const r = await verifier(clone());
        expect(r.problems).toEqual([]);
        expect(r.mismatches).toBe(0);
        expect(r.rows).toHaveLength(6);
        for (const row of r.rows) {
            expect(row.result).toBe("OK");
            expect(row.onchainHash).toBe(row.recomputedHash);
        }
        // PolicySet, 3 spend events, Approved + SpendExecuted(viaApproval), VaultPaused
        expect(r.onchainEvents).toBe(7);
    });

    it("F-12 ②: one tampered field → that record fails HASH_MISMATCH, EVENT_MISMATCH and FIELD_MISMATCH, the others stay OK", async () => {
        const file = clone();
        const target = file.records.find((x) => (x.package as { requestId?: string }).requestId === spends.executed)!;
        (target.package as { request: { amount: string } }).request.amount = "3000";
        const r = await verifier(file);
        const row = r.rows.find((x) => x.evidenceId === target.evidenceId)!;
        expect(row.problems.map((p) => p.code)).toEqual(["HASH_MISMATCH", "EVENT_MISMATCH", "FIELD_MISMATCH"]);
        expect(r.rows.filter((x) => x.result === "OK")).toHaveLength(5);
        expect(r.mismatches).toBe(3);
    });

    it("an anchor pointing at a tx that does not exist → TX_NOT_FOUND", async () => {
        const file = clone();
        file.records[0].anchor!.txHash = `0x${"de".repeat(32)}`;
        expect(codesOf(await verifier(file))).toEqual(["TX_NOT_FOUND"]);
    });

    it("anchors swapped between two spend records → EVENT_MISMATCH and FIELD_MISMATCH on both", async () => {
        const file = clone();
        const [x, y] = [spends.executed, spends.blocked].map((id) => file.records.find((r) => (r.package as { requestId?: string }).requestId === id)!);
        [x.anchor, y.anchor] = [y.anchor, x.anchor];
        const r = await verifier(file);
        for (const rec of [x, y]) expect(r.rows.find((row) => row.evidenceId === rec.evidenceId)!.problems.map((p) => p.code)).toEqual(["EVENT_MISMATCH", "FIELD_MISMATCH"]);
    });

    it("a record removed from the file → its on-chain event is UNMATCHED_ONCHAIN_EVENT", async () => {
        const file = clone();
        file.records = file.records.filter((r) => r.kind !== "pause");
        const r = await verifier(file);
        expect(r.problems).toEqual([expect.objectContaining({ code: "UNMATCHED_ONCHAIN_EVENT", event: "VaultPaused" })]);
    });

    it("a record without an anchor → TX_NOT_FOUND (claimed but never on-chain)", async () => {
        const file = clone();
        file.records[1].anchor = null;
        expect(codesOf(await verifier(file))).toEqual(["TX_NOT_FOUND"]);
    });
});
