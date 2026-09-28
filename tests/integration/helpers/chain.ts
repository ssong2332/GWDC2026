import {
    createPublicClient,
    createTestClient,
    createWalletClient,
    getAddress,
    http,
    parseEventLogs,
    type Address,
    type Hex,
} from "viem";
import { hardhat } from "viem/chains";
import { mockKrwtAbi, mockKrwtBytecode } from "@/adapters/chain/generated/MockKRWT";
import { policyVaultAbi, policyVaultBytecode } from "@/adapters/chain/generated/PolicyVault";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import { hashPackage, type PolicySetEvidence } from "@/core/domain/evidence";
import type { EvidenceRepo } from "@/core/ports";
import { INTEGRATION_RPC_URL } from "./rpc";

// Test-only helpers for layer ③. Owner actions go straight through viem here; the production
// owner path (prepareOwnerAction + wallet signature) belongs to later tasks.

export const publicClient = createPublicClient({ chain: hardhat, transport: http(INTEGRATION_RPC_URL) });
export const walletClient = createWalletClient({ chain: hardhat, transport: http(INTEGRATION_RPC_URL) });
export const testClient = createTestClient({ chain: hardhat, mode: "hardhat", transport: http(INTEGRATION_RPC_URL) });

export const FEE_BPS = 100;

export async function accounts() {
    const [agent, owner, feeRecipient] = await walletClient.getAddresses();
    return { agent, owner, feeRecipient };
}

async function deploy(abi: readonly unknown[], bytecode: Hex, args: unknown[], from: Address): Promise<{ address: Address; block: bigint }> {
    const hash = await walletClient.deployContract({ abi, bytecode, args, account: from, chain: hardhat } as never);
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error("deploy failed");
    return { address: r.contractAddress, block: r.blockNumber };
}

export async function deployVault(mint = 1_000_000n) {
    const { agent, owner, feeRecipient } = await accounts();
    const token = await deploy(mockKrwtAbi, mockKrwtBytecode, [], agent);
    const vault = await deploy(policyVaultAbi, policyVaultBytecode, [token.address, owner, agent, feeRecipient, FEE_BPS], agent);
    if (mint > 0n) {
        const hash = await walletClient.writeContract({
            address: token.address,
            abi: mockKrwtAbi,
            functionName: "mint",
            args: [vault.address, mint],
            account: agent,
            chain: hardhat,
        });
        await publicClient.waitForTransactionReceipt({ hash });
    }
    return { vault: vault.address, token: token.address, deployBlock: vault.block, agent, owner, feeRecipient };
}
export type Deployed = Awaited<ReturnType<typeof deployVault>>;

export const DEMO_DELEGATION = "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐";
export const DEMO_PURPOSE = "Supplies for the student club welcome party";

export async function latestTimestamp(): Promise<number> {
    return Number((await publicClient.getBlock()).timestamp);
}

/** Stores a policy_set evidence package locally and registers the policy on-chain with its hash. */
export async function registerPolicy(
    d: Deployed,
    evidence: EvidenceRepo,
    over: { budget?: bigint; approvalThreshold?: bigint; merchantIds?: string[]; expiresInSeconds?: number } = {},
) {
    const merchants = MERCHANT_REGISTRY.filter((m) => (over.merchantIds ?? ["daiso", "coupang"]).includes(m.id));
    const expiresAt = (await latestTimestamp()) + (over.expiresInSeconds ?? 7 * 86_400);
    const budget = over.budget ?? 200_000n;
    const approvalThreshold = over.approvalThreshold ?? 50_000n;
    const pkg: PolicySetEvidence = {
        schema: "agent-spend-evidence/v1",
        chainId: hardhat.id,
        vault: getAddress(d.vault),
        createdAt: new Date().toISOString(),
        kind: "policy_set",
        owner: getAddress(d.owner),
        delegationText: DEMO_DELEGATION,
        kiln: null,
        candidate: null,
        final: {
            budget: budget.toString(),
            approvalThreshold: approvalThreshold.toString(),
            expiresAt,
            expiresAtSource: "owner",
            maxPerMinute: 3,
            maxPerDay: 20,
            purpose: DEMO_PURPOSE,
            merchants: merchants.map((m) => ({ id: m.id, displayName: m.displayName, address: getAddress(m.address) })),
        },
        ownerEdits: [],
        feeBps: FEE_BPS,
    };
    const { canonical, hash } = hashPackage(pkg);
    evidence.insert({
        evidenceId: crypto.randomUUID(),
        kind: "policy_set",
        chainId: hardhat.id,
        vault: getAddress(d.vault),
        requestId: null,
        packageJson: canonical,
        evidenceHash: hash,
        createdAt: pkg.createdAt,
    });
    const tx = await walletClient.writeContract({
        address: d.vault,
        abi: policyVaultAbi,
        functionName: "setPolicy",
        args: [
            {
                budget,
                approvalThreshold,
                expiresAt: BigInt(expiresAt),
                maxPerMinute: 3,
                maxPerDay: 20,
                merchants: merchants.map((m) => getAddress(m.address)),
            },
            hash,
        ],
        account: d.owner,
        chain: hardhat,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    return { policyEvidenceHash: hash };
}

export async function ownerCall(d: Deployed, fn: "approve" | "reject", requestId: Hex, evidenceHash: Hex) {
    const tx = await walletClient.writeContract({
        address: d.vault,
        abi: policyVaultAbi,
        functionName: fn,
        args: [requestId, evidenceHash],
        account: d.owner,
        chain: hardhat,
    });
    const r = await publicClient.waitForTransactionReceipt({ hash: tx });
    return parseEventLogs({ abi: policyVaultAbi, logs: r.logs });
}

export async function pause(d: Deployed, evidenceHash: Hex) {
    const tx = await walletClient.writeContract({
        address: d.vault,
        abi: policyVaultAbi,
        functionName: "pause",
        args: [evidenceHash],
        account: d.owner,
        chain: hardhat,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
}

export async function tokenBalance(d: Deployed, who: Address): Promise<bigint> {
    return publicClient.readContract({ address: d.token, abi: mockKrwtAbi, functionName: "balanceOf", args: [who] });
}

export async function agentNonce(d: Deployed): Promise<number> {
    return publicClient.getTransactionCount({ address: d.agent });
}

/** Moves chain time to the start of the next minute so a test never straddles a rate-limit window. */
export async function freshMinute(): Promise<void> {
    const now = await latestTimestamp();
    await testClient.setNextBlockTimestamp({ timestamp: BigInt((Math.floor(now / 60) + 1) * 60) });
    await testClient.mine({ blocks: 1 });
}
