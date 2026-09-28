import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { BaseError, ContractFunctionRevertedError, keccak256, parseEventLogs, toHex, type Address, type Hex } from "viem";

export const FEE_BPS = 100;
export const DEFAULT_VAULT_BALANCE = 1_000_000n;
export const DAY = 86_400;
export const MINUTE = 60;

export const REASON = {
    NONE: 0,
    PAUSED: 1,
    NO_POLICY: 2,
    EXPIRED: 3,
    RATE_LIMIT_MINUTE: 4,
    RATE_LIMIT_DAY: 5,
    MERCHANT_NOT_ALLOWED: 6,
    OVER_BUDGET: 7,
    INSUFFICIENT_VAULT_BALANCE: 8,
} as const;

export const FLAG = { OVER_THRESHOLD: 1, AGENT_REVIEW_REQUEST: 2 } as const;
export const STATUS = { NONE: 0, PENDING: 1, APPROVED: 2, REJECTED: 3 } as const;

export const POLICY_FIELD = {
    BUDGET: 1,
    APPROVAL_THRESHOLD: 2,
    EXPIRES_AT: 3,
    MAX_PER_MINUTE: 4,
    MAX_PER_DAY: 5,
    MERCHANTS: 6,
} as const;

export function hashOf(label: string): Hex {
    return keccak256(toHex(label));
}

export async function deployVault() {
    const [agent, owner, feeRecipient, merchantA, merchantB, merchantX, stranger] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();
    const token = await hre.viem.deployContract("MockKRWT");
    const vault = await hre.viem.deployContract("PolicyVault", [
        token.address,
        owner.account.address,
        agent.account.address,
        feeRecipient.account.address,
        FEE_BPS,
    ]);
    return { vault, token, publicClient, agent, owner, feeRecipient, merchantA, merchantB, merchantX, stranger };
}

export type VaultFixture = Awaited<ReturnType<typeof deployVault>>;

export async function deployFundedVault(): Promise<VaultFixture> {
    const f = await deployVault();
    await mintToVault(f, DEFAULT_VAULT_BALANCE);
    return f;
}

// 분·일 버킷 경계에 걸려 테스트가 흔들리지 않도록, 매 테스트를 새 UTC 날짜의 0초에서 시작한다.
export async function alignToNextDay(): Promise<number> {
    const now = await time.latest();
    const dayStart = (Math.floor(now / DAY) + 1) * DAY;
    await time.increaseTo(dayStart);
    return dayStart;
}

export async function mintToVault(f: VaultFixture, amount: bigint): Promise<void> {
    const hash = await f.token.write.mint([f.vault.address, amount]);
    await f.publicClient.waitForTransactionReceipt({ hash });
}

export interface PolicyInput {
    budget: bigint;
    approvalThreshold: bigint;
    expiresAt: bigint;
    maxPerMinute: number;
    maxPerDay: number;
    merchants: Address[];
}

export async function buildPolicy(f: VaultFixture, overrides: Partial<PolicyInput> = {}): Promise<PolicyInput> {
    const now = BigInt(await time.latest());
    return {
        budget: 200_000n,
        approvalThreshold: 50_000n,
        expiresAt: now + 7n * BigInt(DAY),
        maxPerMinute: 3,
        maxPerDay: 20,
        merchants: [f.merchantA.account.address, f.merchantB.account.address],
        ...overrides,
    };
}

export async function setPolicy(f: VaultFixture, overrides: Partial<PolicyInput> = {}, evidenceHash: Hex = hashOf("policy")) {
    const policy = await buildPolicy(f, overrides);
    const hash = await f.vault.write.setPolicy([policy, evidenceHash], { account: f.owner.account });
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash });
    return { policy, receipt, logs: vaultLogs(f, receipt.logs) };
}

export interface SpendArgs {
    requestId: Hex;
    merchant: Address;
    amount: bigint;
    agentReviewRequest?: boolean;
    evidenceHash?: Hex;
}

function spendTuple(a: SpendArgs) {
    return [a.requestId, a.merchant, a.amount, a.agentReviewRequest ?? false, a.evidenceHash ?? hashOf(`evidence:${a.requestId}`)] as const;
}

export async function spend(f: VaultFixture, a: SpendArgs) {
    const hash = await f.vault.write.spend(spendTuple(a), { account: f.agent.account });
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash });
    return { receipt, logs: vaultLogs(f, receipt.logs) };
}

export async function simulateSpend(f: VaultFixture, a: SpendArgs): Promise<boolean> {
    const { result } = await f.vault.simulate.spend(spendTuple(a), { account: f.agent.account });
    return result as boolean;
}

export async function ownerCall(f: VaultFixture, fn: "approve" | "reject", requestId: Hex, evidenceHash: Hex) {
    const hash = await f.vault.write[fn]([requestId, evidenceHash], { account: f.owner.account });
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash });
    return { receipt, logs: vaultLogs(f, receipt.logs) };
}

export async function ownerToggle(f: VaultFixture, fn: "pause" | "unpause", evidenceHash: Hex) {
    const hash = await f.vault.write[fn]([evidenceHash], { account: f.owner.account });
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash });
    return { receipt, logs: vaultLogs(f, receipt.logs) };
}

export function vaultLogs(f: VaultFixture, logs: readonly { address: Address }[]) {
    const own = logs.filter((l) => l.address.toLowerCase() === f.vault.address.toLowerCase());
    return parseEventLogs({ abi: f.vault.abi, logs: own as never });
}

export async function balances(f: VaultFixture) {
    const of = (a: Address) => f.token.read.balanceOf([a]);
    return {
        vault: await of(f.vault.address),
        merchantA: await of(f.merchantA.account.address),
        merchantB: await of(f.merchantB.account.address),
        merchantX: await of(f.merchantX.account.address),
        feeRecipient: await of(f.feeRecipient.account.address),
    };
}

export async function expectRevert(promise: Promise<unknown>, errorName: string, args?: readonly unknown[]): Promise<void> {
    let caught: unknown;
    try {
        await promise;
    } catch (e) {
        caught = e;
    }
    expect(caught, `expected revert ${errorName}, but call succeeded`).to.not.equal(undefined);
    const decoded = decodeRevert(caught);
    expect(decoded?.name, String(caught)).to.equal(errorName);
    if (args) {
        expect(decoded?.args).to.deep.equal(args.map(String));
    }
}

// viem decodes the revert only when the RPC returns revert data; Hardhat's in-process provider often returns
// just "reverted with custom error 'Name(arg,...)'" in the message, so both forms are accepted.
function decodeRevert(err: unknown): { name: string; args: string[] } | null {
    if (err instanceof BaseError) {
        const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
        if (revert?.data?.errorName) {
            return { name: revert.data.errorName, args: (revert.data.args ?? []).map(String) };
        }
    }
    const m = String(err).match(/reverted with custom error '(\w+)\((.*?)\)'/);
    if (!m) return null;
    return { name: m[1], args: m[2] === "" ? [] : m[2].split(",").map((s) => s.trim()) };
}
