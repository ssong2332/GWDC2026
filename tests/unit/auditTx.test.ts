import { describe, expect, it } from "vitest";
import { hashPackage } from "@/core/domain/evidence";
import type { Hex } from "@/core/domain/types";
import type { ChainEventRepo, DecodedVaultEvent, EvidenceRepo, EvidenceRow, VaultReader } from "@/core/ports";
import { verifyTx } from "@/core/usecases/verifyTx";

// F-13 audit: tx hash → vault events of that tx → local evidence re-hashed vs the on-chain hash → replay verdict.
// Reader / repos are in-memory stubs (the Hardhat path is covered by tests/integration/auditEfficiency.test.ts).

const VAULT = "0x00000000000000000000000000000000000Fa017" as Hex;
const OWNER = "0x00000000000000000000000000000000000000A1" as Hex;
const DAISO = "0x000000000000000000000000000000000000dA15";
const GMARKET = "0x0000000000000000000000000000000000009a4E";
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const rid = (n: number) => `0x${(n + 1000).toString(16).padStart(64, "0")}` as Hex;

const policyPkg = { kind: "policy_set", v: 1 };
const spendPkg = { kind: "spend_request", requestId: rid(2), amount: "30000" };
const blockedPkg = { kind: "spend_request", requestId: rid(3), amount: "20000" };
const H = { policy: hashPackage(policyPkg).hash, spend: hashPackage(spendPkg).hash, blocked: hashPackage(blockedPkg).hash };

function ev(name: string, txN: number, logIndex: number, args: Record<string, unknown>, block = txN): DecodedVaultEvent {
    return { name, txHash: tx(txN), logIndex, blockNumber: BigInt(block), blockTimestamp: 1_900_000_000 + block, args };
}
const policySet = ev("PolicySet", 1, 0, { policyVersion: 1n, budget: 200_000n, approvalThreshold: 50_000n, expiresAt: 2_000_000_000n, merchants: [DAISO], evidenceHash: H.policy });
const executed = ev("SpendExecuted", 2, 0, { requestId: rid(2), merchant: DAISO, amount: 30_000n, fee: 300n, policyVersion: 1n, viaApproval: false, evidenceHash: H.spend });
const blocked = ev("SpendBlocked", 3, 0, { requestId: rid(3), merchant: GMARKET, amount: 20_000n, reason: 6, evidenceHash: H.blocked });
const approvedHash = hashPackage({ kind: "approval", requestId: rid(4) }).hash;
const approved = ev("Approved", 4, 0, { requestId: rid(4), approver: OWNER, evidenceHash: approvedHash });
const bigSpend = ev("SpendExecuted", 4, 1, { requestId: rid(4), merchant: DAISO, amount: 60_000n, fee: 600n, policyVersion: 1n, viaApproval: true, evidenceHash: hashPackage({ x: 1 }).hash });
const outside = ev("SpendExecuted", 5, 0, { requestId: rid(5), merchant: GMARKET, amount: 1_000n, fee: 10n, policyVersion: 1n, viaApproval: false, evidenceHash: hashPackage({ y: 1 }).hash });
const ALL = [policySet, executed, blocked, approved, bigSpend, outside];

function row(kind: string, pkg: unknown, hash: Hex, packageJson = JSON.stringify(pkg)): EvidenceRow {
    return { evidenceId: `e-${kind}-${hash.slice(2, 8)}`, kind, chainId: 31337, vault: VAULT, requestId: null, packageJson, evidenceHash: hash, createdAt: "2026-09-28T00:00:00.000Z", anchor: null, anchoredAt: null };
}

function deps(evidenceRows: EvidenceRow[], receipts: Record<string, { status: "success" | "reverted"; events: DecodedVaultEvent[] } | null>) {
    const reader = {
        getReceiptEvents: async (h: Hex) => {
            const r = receipts[h.toLowerCase()];
            return r === undefined || r === null ? null : { ...r, blockNumber: BigInt(Number.parseInt(h.slice(-4), 16)) };
        },
    } as unknown as VaultReader;
    const evidence = { findByHash: (h: Hex) => evidenceRows.find((r) => r.evidenceHash.toLowerCase() === h.toLowerCase()) ?? null } as unknown as EvidenceRepo;
    const chainEvents = { list: () => ALL } as unknown as ChainEventRepo;
    return { chainId: 31337, vault: VAULT, reader, evidence, chainEvents };
}
const receiptOf = (...events: DecodedVaultEvent[]) => ({ status: "success" as const, events });
const allReceipts = {
    [tx(1)]: receiptOf(policySet),
    [tx(2)]: receiptOf(executed),
    [tx(3)]: receiptOf(blocked),
    [tx(4)]: receiptOf(approved, bigSpend),
    [tx(5)]: receiptOf(outside),
    [tx(9)]: receiptOf(),
};
const stored = [row("policy_set", policyPkg, H.policy), row("spend_request", spendPkg, H.spend), row("spend_request", blockedPkg, H.blocked)];

describe("verifyTx (F-13)", () => {
    it("executed payment → evidence package, hash match, within policy (F-13 ①)", async () => {
        const r = await verifyTx(deps(stored, allReceipts), tx(2));
        if (r.status !== "found") throw new Error("expected found");
        expect(r.txHash).toBe(tx(2));
        expect(r.blockNumber).toBe("2");
        expect(r.items).toHaveLength(1);
        expect(r.items[0]).toMatchObject({
            event: "SpendExecuted",
            evidenceKind: "spend_request",
            package: spendPkg,
            recomputedHash: H.spend,
            onchainHash: H.spend,
            hashMatch: true,
            withinPolicy: true,
            blockReason: null,
            approver: null,
        });
    });

    it("SpendBlocked → blocked reason label, withinPolicy not applicable (F-13 ②)", async () => {
        const r = await verifyTx(deps(stored, allReceipts), tx(3));
        expect(r.status === "found" && r.items[0]).toMatchObject({ event: "SpendBlocked", hashMatch: true, withinPolicy: null, blockReason: "Merchant not allowed" });
    });

    it("unknown tx, or a tx with no vault event → not_found (F-13 ③)", async () => {
        expect(await verifyTx(deps(stored, allReceipts), tx(77))).toEqual({ status: "not_found" });
        expect(await verifyTx(deps(stored, allReceipts), tx(9))).toEqual({ status: "not_found" });
    });

    it("stored package altered after anchoring → hashMatch false with both hashes shown", async () => {
        const tampered = [row("spend_request", spendPkg, H.spend, JSON.stringify({ ...spendPkg, amount: "1" }))];
        const r = await verifyTx(deps(tampered, allReceipts), tx(2));
        if (r.status !== "found") throw new Error("expected found");
        expect(r.items[0].hashMatch).toBe(false);
        expect(r.items[0].onchainHash).toBe(H.spend);
        expect(r.items[0].recomputedHash).not.toBe(H.spend);
    });

    it("no local evidence → hashMatch null, package null; approval tx carries the approver on both events", async () => {
        const r = await verifyTx(deps([], allReceipts), tx(4));
        if (r.status !== "found") throw new Error("expected found");
        expect(r.items.map((i) => [i.event, i.hashMatch, i.package, i.evidenceKind, i.approver])).toEqual([
            ["Approved", null, null, null, OWNER],
            ["SpendExecuted", null, null, null, OWNER],
        ]);
        expect(r.items[1].withinPolicy).toBe(true);
    });

    it("execution outside the replayed policy → withinPolicy false", async () => {
        const r = await verifyTx(deps(stored, allReceipts), tx(5));
        expect(r.status === "found" && r.items[0].withinPolicy).toBe(false);
    });
});
