import {
    BaseError,
    ContractFunctionRevertedError,
    TransactionReceiptNotFoundError,
    getAddress,
    parseEventLogs,
    type Account,
    type Address,
    type Chain,
    type Log,
    type PublicClient,
    type WalletClient,
} from "viem";
import { LOG_BLOCK_CHUNK } from "@/config/constants";
import type { Hex, VaultStateSnapshot } from "@/core/domain/types";
import { AppError } from "@/core/errors";
import type { AgentVaultWriter, DecodedVaultEvent, VaultReader } from "@/core/ports";
import { policyVaultAbi } from "./generated/PolicyVault";

// viem implementation of the vault ports (Architecture 7). Only this file knows the ABI shapes.

async function decodeVaultLogs(client: PublicClient, vault: Address, logs: readonly Log[]): Promise<DecodedVaultEvent[]> {
    const own = logs.filter((l) => l.address.toLowerCase() === vault.toLowerCase());
    const decoded = parseEventLogs({ abi: policyVaultAbi, logs: own });
    const timestamps = new Map<bigint, number>();
    for (const bn of new Set(decoded.map((l) => l.blockNumber as bigint))) {
        timestamps.set(bn, Number((await client.getBlock({ blockNumber: bn })).timestamp));
    }
    return decoded.map((l) => ({
        name: l.eventName,
        txHash: l.transactionHash as Hex,
        logIndex: l.logIndex as number,
        blockNumber: l.blockNumber as bigint,
        blockTimestamp: timestamps.get(l.blockNumber as bigint) ?? 0,
        args: { ...(l.args as Record<string, unknown>) },
    }));
}

export function createViemVaultReader(opts: { client: PublicClient; vault: Address; chainId: number }): VaultReader {
    const { client, vault, chainId } = opts;
    const read = <T>(functionName: string, args: unknown[] = []) =>
        client.readContract({ address: vault, abi: policyVaultAbi, functionName, args } as never) as Promise<T>;

    return {
        async getState(): Promise<VaultStateSnapshot> {
            const s = await read<{
                paused: boolean;
                policyVersion: bigint;
                budget: bigint;
                spent: bigint;
                reserved: bigint;
                approvalThreshold: bigint;
                expiresAt: bigint;
                maxPerMinute: number;
                maxPerDay: number;
                minuteBucket: bigint;
                minuteCount: number;
                dayBucket: bigint;
                dayCount: number;
                pendingCount: number;
                vaultBalance: bigint;
                feeBps: number;
                merchants: readonly Address[];
                blockTimestamp: bigint;
                blockNumber: bigint;
            }>("getState");
            return {
                chainId,
                vault: getAddress(vault),
                paused: s.paused,
                policyVersion: s.policyVersion,
                budget: s.budget,
                spent: s.spent,
                reserved: s.reserved,
                approvalThreshold: s.approvalThreshold,
                expiresAt: Number(s.expiresAt),
                maxPerMinute: s.maxPerMinute,
                maxPerDay: s.maxPerDay,
                minuteBucket: s.minuteBucket,
                minuteCount: s.minuteCount,
                dayBucket: s.dayBucket,
                dayCount: s.dayCount,
                pendingCount: s.pendingCount,
                vaultBalance: s.vaultBalance,
                feeBps: s.feeBps,
                merchants: s.merchants.map((m) => getAddress(m)),
                blockTimestamp: Number(s.blockTimestamp),
                blockNumber: s.blockNumber,
            };
        },
        remainingBudget: () => read<bigint>("remainingBudget"),
        async getPending(requestId) {
            const p = await read<{
                merchant: Address;
                amount: bigint;
                fee: bigint;
                flags: number;
                status: number;
                evidenceHash: Hex;
            }>("getPending", [requestId]);
            return {
                merchant: getAddress(p.merchant),
                amount: p.amount,
                fee: p.fee,
                flags: p.flags,
                status: p.status,
                evidenceHash: p.evidenceHash,
            };
        },
        async getReceiptEvents(txHash) {
            try {
                const r = await client.getTransactionReceipt({ hash: txHash });
                return { status: r.status, blockNumber: r.blockNumber, events: await decodeVaultLogs(client, vault, r.logs) };
            } catch (err) {
                if (err instanceof TransactionReceiptNotFoundError) return null;
                throw new AppError("CHAIN_RPC_ERROR", "could not read the transaction receipt", true, { cause: err });
            }
        },
        async getLogs(fromBlock, toBlock) {
            const out: DecodedVaultEvent[] = [];
            for (let start = fromBlock; start <= toBlock; start += LOG_BLOCK_CHUNK) {
                const end = start + LOG_BLOCK_CHUNK - 1n < toBlock ? start + LOG_BLOCK_CHUNK - 1n : toBlock;
                const logs = await client.getLogs({ address: vault, fromBlock: start, toBlock: end });
                out.push(...(await decodeVaultLogs(client, vault, logs)));
            }
            return out;
        },
        // cacheTime 0: viem caches the block number for the polling interval by default, which hides fresh blocks.
        latestBlock: () => client.getBlockNumber({ cacheTime: 0 }),
    };
}

function isRevert(err: unknown): boolean {
    if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError)) return true;
    return /revert/i.test(err instanceof Error ? err.message : String(err));
}

export function createViemAgentWriter(opts: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    vault: Address;
    account: Address | Account;
    chain: Chain;
}): AgentVaultWriter {
    const { walletClient, publicClient, vault, account, chain } = opts;
    return {
        async spend(a) {
            let txHash: Hex;
            try {
                txHash = await walletClient.writeContract({
                    address: vault,
                    abi: policyVaultAbi,
                    functionName: "spend",
                    args: [a.requestId, a.merchant, a.amount, a.agentReviewRequest, a.evidenceHash],
                    account,
                    chain,
                });
            } catch (err) {
                if (isRevert(err)) throw new AppError("CHAIN_TX_REVERTED", "PolicyVault.spend reverted", false, { cause: err });
                throw new AppError("CHAIN_RPC_ERROR", "could not send the spend transaction", true, { cause: err });
            }
            const r = await publicClient.waitForTransactionReceipt({ hash: txHash });
            const l1Fee = (r as { l1Fee?: bigint | null }).l1Fee ?? 0n;
            return {
                txHash,
                receipt: {
                    status: r.status,
                    events: await decodeVaultLogs(publicClient, vault, r.logs),
                    gasUsed: r.gasUsed,
                    feeWei: r.gasUsed * r.effectiveGasPrice + l1Fee,
                },
            };
        },
    };
}
