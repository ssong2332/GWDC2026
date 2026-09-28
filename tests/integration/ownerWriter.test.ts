import { getAddress, type Hex } from "viem";
import { hardhat } from "viem/chains";
import { beforeEach, describe, expect, it } from "vitest";
import { createViemAgentWriter, createViemOwnerWriter, createViemVaultReader } from "@/adapters/chain/viemVault";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import { AppError } from "@/core/errors";
import type { OwnerVaultWriter } from "@/core/ports";
import { deployVault, freshMinute, latestTimestamp, publicClient, walletClient, type Deployed } from "./helpers/chain";

// OwnerVaultWriter (Architecture 7, CLI-only owner path used by E2E and unpause). Every call returns TxResult.

const h = (b: string) => `0x${b.repeat(32)}` as Hex;
const merchants = MERCHANT_REGISTRY.filter((m) => m.id !== "gmarket").map((m) => getAddress(m.address));

function writers(d: Deployed, ownerAccount = d.owner) {
    const owner: OwnerVaultWriter = createViemOwnerWriter({ walletClient, publicClient, vault: d.vault, account: ownerAccount, chain: hardhat });
    const agent = createViemAgentWriter({ walletClient, publicClient, vault: d.vault, account: d.agent, chain: hardhat });
    const reader = createViemVaultReader({ client: publicClient, vault: d.vault, chainId: hardhat.id });
    return { owner, agent, reader };
}

async function policy() {
    return {
        budget: 200_000n,
        approvalThreshold: 50_000n,
        expiresAt: (await latestTimestamp()) + 7 * 86_400,
        maxPerMinute: 3,
        maxPerDay: 20,
        merchantIds: ["daiso", "coupang"],
        purpose: "Supplies for the welcome party",
        merchants,
    };
}

beforeEach(async () => {
    await freshMinute();
});

describe("createViemOwnerWriter", () => {
    it("setPolicy sends PolicyInput + evidence hash; TxResult carries the decoded PolicySet, gas and fee", async () => {
        const d = await deployVault();
        const { owner, reader } = writers(d);
        const p = await policy();

        const r = await owner.setPolicy(p, h("a1"));

        expect(r.receipt.status).toBe("success");
        expect(r.receipt.events.map((e) => e.name)).toEqual(["PolicySet"]);
        expect(r.receipt.events[0]).toMatchObject({ txHash: r.txHash, args: { policyVersion: 1n, by: getAddress(d.owner), budget: 200_000n, evidenceHash: h("a1") } });
        expect(r.receipt.events[0].args.merchants).toEqual(merchants);
        expect(r.receipt.gasUsed > 0n).toBe(true);
        expect(r.receipt.feeWei > 0n).toBe(true);
        expect(await reader.getState()).toMatchObject({ policyVersion: 1n, budget: 200_000n, expiresAt: p.expiresAt, maxPerMinute: 3, merchants });
    });

    it("approve pays a pending request (Approved then SpendExecuted viaApproval); reject releases another", async () => {
        const d = await deployVault();
        const { owner, agent, reader } = writers(d);
        await owner.setPolicy(await policy(), h("a1"));
        await agent.spend({ requestId: h("01"), merchant: merchants[1], amount: 60_000n, agentReviewRequest: false, evidenceHash: h("b1") });
        await agent.spend({ requestId: h("02"), merchant: merchants[0], amount: 10_000n, agentReviewRequest: true, evidenceHash: h("b2") });
        expect((await reader.getState()).reserved).toBe(60_600n + 10_100n);

        const approved = await owner.approve(h("01"), h("c1"));
        expect(approved.receipt.events.map((e) => e.name)).toEqual(["Approved", "SpendExecuted"]);
        expect(approved.receipt.events[1].args).toMatchObject({ requestId: h("01"), viaApproval: true, evidenceHash: h("b1") });

        const rejected = await owner.reject(h("02"), h("c2"));
        expect(rejected.receipt.events.map((e) => e.name)).toEqual(["Rejected"]);
        expect(await reader.getState()).toMatchObject({ reserved: 0n, spent: 60_600n, pendingCount: 0 });
    });

    it("pause then unpause emit VaultPaused / VaultUnpaused with the evidence hash", async () => {
        const d = await deployVault();
        const { owner, reader } = writers(d);
        const paused = await owner.pause(h("d1"));
        expect(paused.receipt.events[0]).toMatchObject({ name: "VaultPaused", args: { by: getAddress(d.owner), evidenceHash: h("d1") } });
        expect((await reader.getState()).paused).toBe(true);
        const unpaused = await owner.unpause(h("d2"));
        expect(unpaused.receipt.events[0]).toMatchObject({ name: "VaultUnpaused", args: { evidenceHash: h("d2") } });
        expect((await reader.getState()).paused).toBe(false);
    });

    it("a non-owner account → CHAIN_TX_REVERTED and the policy is unchanged (F-03 ②)", async () => {
        const d = await deployVault();
        const { owner, reader } = writers(d, d.agent);
        await expect(owner.setPolicy(await policy(), h("a1"))).rejects.toSatisfy((e) => e instanceof AppError && e.code === "CHAIN_TX_REVERTED");
        expect((await reader.getState()).policyVersion).toBe(0n);
    });

    it("unpause while not paused and approve of an unknown request → CHAIN_TX_REVERTED", async () => {
        const d = await deployVault();
        const { owner } = writers(d);
        await expect(owner.unpause(h("d3"))).rejects.toSatisfy((e) => e instanceof AppError && e.code === "CHAIN_TX_REVERTED");
        await expect(owner.approve(h("0f"), h("c3"))).rejects.toSatisfy((e) => e instanceof AppError && e.code === "CHAIN_TX_REVERTED");
    });
});
