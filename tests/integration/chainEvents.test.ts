import type Database from "better-sqlite3";
import { getAddress, type Hex } from "viem";
import { hardhat } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createViemAgentWriter, createViemVaultReader } from "@/adapters/chain/viemVault";
import { createChainEventRepo } from "@/adapters/db/chainEventRepo";
import { createEvidenceRepo } from "@/adapters/db/evidenceRepo";
import { createKilnCallRepo } from "@/adapters/db/kilnCallRepo";
import { openDatabase } from "@/adapters/db/sqlite";
import { createSpendRequestRepo } from "@/adapters/db/spendRequestRepo";
import { FakeKilnClient, defaultFakeHandler } from "@/adapters/kiln/fakeKilnClient";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import type { DecodedVaultEvent, VaultReader } from "@/core/ports";
import { processSpendRequest } from "@/core/usecases/processSpendRequest";
import { pullNewEvents, syncChainEvents } from "@/core/usecases/syncChainEvents";
import { deployVault, freshMinute, ownerCall, pause, publicClient, registerPolicy, walletClient, type Deployed } from "./helpers/chain";

const VAULT_A = getAddress("0x00000000000000000000000000000000000000a1");
const VAULT_B = getAddress("0x00000000000000000000000000000000000000b2");
const h = (b: string) => `0x${b.repeat(32)}` as Hex;

function ev(over: Partial<DecodedVaultEvent> & { args?: Record<string, unknown> }): DecodedVaultEvent {
    return { name: "SpendExecuted", txHash: h("01"), logIndex: 0, blockNumber: 1n, blockTimestamp: 1_700_000_000, args: {}, ...over };
}

let db: Database.Database;
beforeEach(() => {
    db = openDatabase(":memory:");
});
afterEach(() => db.close());

describe("ChainEventRepo (src/adapters/db/chainEventRepo.ts — bigint tagged encoding, D-33)", () => {
    it("round-trips decoded events unchanged: bigint, number, boolean, string and address arrays", () => {
        const repo = createChainEventRepo(db);
        const e = ev({
            name: "PolicySet",
            blockNumber: 12n,
            args: {
                policyVersion: 1n,
                by: VAULT_B,
                budget: 2n ** 200n, // far beyond Number.MAX_SAFE_INTEGER
                approvalThreshold: 0n,
                expiresAt: 1_800_000_000n,
                maxPerMinute: 3,
                maxPerDay: 20,
                merchants: [VAULT_A, VAULT_B],
                evidenceHash: h("ee"),
                viaApproval: false,
            },
        });
        repo.upsertMany([e], 31337, VAULT_A);
        const [back] = repo.list(31337, VAULT_A);
        expect(back).toEqual(e);
        expect(typeof back.args.budget).toBe("bigint");
        expect(typeof back.args.maxPerMinute).toBe("number");
    });

    it("stores requestId and evidenceHash in their own columns", () => {
        createChainEventRepo(db).upsertMany([ev({ args: { requestId: h("aa"), evidenceHash: h("bb"), amount: 5n } })], 31337, VAULT_A);
        expect(db.prepare("SELECT request_id, evidence_hash, block_number FROM chain_events").get()).toEqual({
            request_id: h("aa"),
            evidence_hash: h("bb"),
            block_number: "1",
        });
    });

    it("upsert is idempotent on (chainId, txHash, logIndex)", () => {
        const repo = createChainEventRepo(db);
        const e = ev({ args: { amount: 1n } });
        repo.upsertMany([e], 31337, VAULT_A);
        repo.upsertMany([e, e], 31337, VAULT_A);
        expect(repo.list(31337, VAULT_A)).toHaveLength(1);
    });

    it("lists by numeric block order then log index (block 9 before 10), filtered by (chainId, vault)", () => {
        const repo = createChainEventRepo(db);
        repo.upsertMany(
            [
                ev({ txHash: h("10"), blockNumber: 10n, logIndex: 0 }),
                ev({ txHash: h("09"), blockNumber: 9n, logIndex: 1 }),
                ev({ txHash: h("09"), blockNumber: 9n, logIndex: 0 }),
            ],
            31337,
            VAULT_A,
        );
        repo.upsertMany([ev({ txHash: h("99"), blockNumber: 1n })], 31337, VAULT_B);
        repo.upsertMany([ev({ txHash: h("98"), blockNumber: 1n })], 84532, VAULT_A);
        expect(repo.list(31337, VAULT_A).map((e) => [e.blockNumber, e.logIndex])).toEqual([
            [9n, 0],
            [9n, 1],
            [10n, 0],
        ]);
        expect(repo.list(1, VAULT_A)).toEqual([]);
        expect(repo.findByTx(h("09")).map((e) => e.logIndex)).toEqual([0, 1]);
        expect(repo.findByTx(h("77"))).toEqual([]);
    });

    it("sync cursor: null before the first sync, then the stored block per (chainId, vault)", () => {
        const repo = createChainEventRepo(db);
        expect(repo.getSyncBlock(31337, VAULT_A)).toBeNull();
        repo.setSyncBlock(31337, VAULT_A, 0n);
        expect(repo.getSyncBlock(31337, VAULT_A)).toBe(0n);
        repo.setSyncBlock(31337, VAULT_A, 12_345_678_901n);
        expect(repo.getSyncBlock(31337, VAULT_A)).toBe(12_345_678_901n);
        expect(repo.getSyncBlock(31337, VAULT_B)).toBeNull();
    });
});

type Range = { from: bigint; to: bigint };
function spyReader(d: Deployed): { reader: VaultReader; ranges: Range[] } {
    const live = createViemVaultReader({ client: publicClient, vault: d.vault, chainId: hardhat.id });
    const ranges: Range[] = [];
    return {
        ranges,
        reader: {
            ...live,
            getLogs: (from, to) => {
                ranges.push({ from, to });
                return live.getLogs(from, to);
            },
        },
    };
}

describe("pullNewEvents / syncChainEvents (src/core/usecases/syncChainEvents.ts, ADR-0004)", () => {
    it("first pull scans from deployBlock to latest; the next pull only scans new blocks; nothing new → no scan", async () => {
        const d = await deployVault();
        const evidence = createEvidenceRepo(db);
        await registerPolicy(d, evidence);
        const chainEvents = createChainEventRepo(db);
        const { reader, ranges } = spyReader(d);
        const base = { reader, chainEvents, chainId: hardhat.id, vault: getAddress(d.vault), deployBlock: d.deployBlock };

        const first = await pullNewEvents(base);
        const latest = await publicClient.getBlockNumber();
        expect(first).toEqual({ newEvents: 1, toBlock: latest });
        expect(ranges).toEqual([{ from: d.deployBlock, to: latest }]);
        expect(chainEvents.getSyncBlock(hardhat.id, getAddress(d.vault))).toBe(latest);
        expect(chainEvents.list(hardhat.id, getAddress(d.vault)).map((e) => e.name)).toEqual(["PolicySet"]);

        const idle = await pullNewEvents(base);
        expect(idle).toEqual({ newEvents: 0, toBlock: latest });
        expect(ranges).toHaveLength(1);

        await pause(d, h("14"));
        const next = await pullNewEvents(base);
        expect(ranges[1].from).toBe(latest + 1n);
        expect(next.newEvents).toBe(1);
        expect(chainEvents.list(hardhat.id, getAddress(d.vault)).map((e) => e.name)).toEqual(["PolicySet", "VaultPaused"]);
    });

    it("a cursor moved backwards (concurrent callers) re-scans and upserts idempotently", async () => {
        const d = await deployVault();
        await registerPolicy(d, createEvidenceRepo(db));
        const chainEvents = createChainEventRepo(db);
        const base = {
            reader: createViemVaultReader({ client: publicClient, vault: d.vault, chainId: hardhat.id }),
            chainEvents,
            chainId: hardhat.id,
            vault: getAddress(d.vault),
            deployBlock: d.deployBlock,
        };
        await pullNewEvents(base);
        chainEvents.setSyncBlock(hardhat.id, getAddress(d.vault), d.deployBlock - 1n);
        const again = await pullNewEvents(base);
        expect(again.newEvents).toBe(1);
        expect(chainEvents.list(hardhat.id, getAddress(d.vault))).toHaveLength(1);
    });

    it("syncChainEvents anchors unanchored evidence once and never moves an existing anchor (viaApproval SpendExecuted)", async () => {
        await freshMinute();
        const d = await deployVault();
        const evidence = createEvidenceRepo(db);
        const { policyEvidenceHash } = await registerPolicy(d, evidence);
        const chainEvents = createChainEventRepo(db);
        const reader = createViemVaultReader({ client: publicClient, vault: d.vault, chainId: hardhat.id });
        const deps = { reader, chainEvents, evidence, chainId: hardhat.id, vault: getAddress(d.vault), deployBlock: d.deployBlock };

        expect(evidence.findByHash(policyEvidenceHash)?.anchor).toBeNull();
        const first = await syncChainEvents(deps);
        expect(first.anchored).toBe(1);
        const anchor = evidence.findByHash(policyEvidenceHash)?.anchor;
        expect(anchor).toMatchObject({ event: "PolicySet", logIndex: expect.any(Number) });
        expect(anchor?.args).toMatchObject({ policyVersion: "1", budget: "200000", evidenceHash: policyEvidenceHash });
        const [policySet] = chainEvents.list(hardhat.id, getAddress(d.vault));
        expect(anchor?.txHash).toBe(policySet.txHash);

        // A pending spend (anchored by processSpendRequest to SpendPending), then the owner approves it.
        const out = await processSpendRequest(
            {
                chainId: hardhat.id,
                vault: getAddress(d.vault),
                deployBlock: d.deployBlock,
                reader,
                writer: createViemAgentWriter({ walletClient, publicClient, vault: d.vault, account: d.agent, chain: hardhat }),
                kiln: new FakeKilnClient(defaultFakeHandler),
                evidence,
                kilnCalls: createKilnCallRepo(db),
                spendRequests: createSpendRequestRepo(db),
                chainEvents,
                merchants: MERCHANT_REGISTRY,
                clock: { now: () => new Date() },
            },
            { merchantId: "coupang", amount: 60_000n, itemDescription: "Portable speaker for the event" },
        );
        expect(out.outcome).toBe("pending");
        await ownerCall(d, "approve", out.requestId, h("ab"));
        const second = await syncChainEvents(deps);
        expect(second.anchored).toBe(0);
        expect(evidence.findByHash(out.evidenceHash)?.anchor?.event).toBe("SpendPending");
        expect(chainEvents.list(hardhat.id, getAddress(d.vault)).map((e) => e.name)).toEqual([
            "PolicySet",
            "SpendPending",
            "Approved",
            "SpendExecuted",
        ]);
        expect(second.toBlock).toBe(await publicClient.getBlockNumber());
    });
});
