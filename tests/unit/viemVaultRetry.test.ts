import { BlockNotFoundError, HttpRequestError, encodeAbiParameters, encodeEventTopics, getAddress, type Log } from "viem";
import { describe, expect, it, vi } from "vitest";
import { policyVaultAbi } from "@/adapters/chain/generated/PolicyVault";
import { createViemAgentWriter, createViemVaultReader } from "@/adapters/chain/viemVault";

// T-07 repro: a load-balanced public RPC (sepolia.base.org) can answer from a node that has not seen the block yet.
// Observed: `Block at number "47416423" could not be found.` right after a receipt from another node.

const VAULT = getAddress("0x00000000000000000000000000000000000000a1");
const BY = getAddress("0x00000000000000000000000000000000000000b2");
const TX = `0x${"11".repeat(32)}` as const;
const EVIDENCE = `0x${"22".repeat(32)}` as const;
const BLOCK = 47_416_423n;
const noSleep = { sleep: async () => {} };

function pausedLog(blockNumber = BLOCK): Log {
    return {
        address: VAULT,
        topics: encodeEventTopics({ abi: policyVaultAbi, eventName: "VaultPaused", args: { by: BY } }) as Log["topics"],
        data: encodeAbiParameters([{ type: "bytes32" }], [EVIDENCE]),
        blockNumber,
        blockHash: `0x${"33".repeat(32)}`,
        transactionHash: TX,
        transactionIndex: 0,
        logIndex: 0,
        removed: false,
    } as Log;
}

/** getBlock fails `misses` times with BlockNotFoundError (lagging node), then succeeds. */
function laggingGetBlock(misses: number) {
    let n = 0;
    return vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
        if (n++ < misses) throw new BlockNotFoundError({ blockNumber });
        return { number: blockNumber, timestamp: 1_700_000_000n };
    });
}

const receipt = { status: "success", logs: [pausedLog()], gasUsed: 21_000n, effectiveGasPrice: 1n, blockNumber: BLOCK };

describe("viemVault on a lagging RPC node (T-07, src/adapters/chain/viemVault.ts)", () => {
    it("spend: getBlock misses twice after the receipt → retried, events decoded, the tx is sent exactly once", async () => {
        const getBlock = laggingGetBlock(2);
        const writeContract = vi.fn(async () => TX);
        const writer = createViemAgentWriter({
            walletClient: { writeContract } as never,
            publicClient: { waitForTransactionReceipt: async () => receipt, getBlock } as never,
            vault: VAULT,
            account: BY,
            chain: { id: 84532 } as never,
            retry: noSleep,
        });

        const out = await writer.spend({ requestId: 1n, merchant: BY, amount: 1n, agentReviewRequest: false, evidenceHash: EVIDENCE } as never);

        expect(out.receipt.events).toEqual([
            { name: "VaultPaused", txHash: TX, logIndex: 0, blockNumber: BLOCK, blockTimestamp: 1_700_000_000, args: { by: BY, evidenceHash: EVIDENCE } },
        ]);
        expect(getBlock).toHaveBeenCalledTimes(3);
        expect(writeContract).toHaveBeenCalledTimes(1);
    });

    it("waitForTransactionReceipt hitting a lagging node is retried (read), writeContract is not repeated", async () => {
        let n = 0;
        const waitForTransactionReceipt = vi.fn(async () => {
            if (n++ < 1) throw new BlockNotFoundError({ blockNumber: BLOCK });
            return receipt;
        });
        const writeContract = vi.fn(async () => TX);
        const writer = createViemAgentWriter({
            walletClient: { writeContract } as never,
            publicClient: { waitForTransactionReceipt, getBlock: laggingGetBlock(0) } as never,
            vault: VAULT,
            account: BY,
            chain: { id: 84532 } as never,
            retry: noSleep,
        });
        const out = await writer.spend({ requestId: 1n, merchant: BY, amount: 1n, agentReviewRequest: false, evidenceHash: EVIDENCE } as never);
        expect(out.txHash).toBe(TX);
        expect(waitForTransactionReceipt).toHaveBeenCalledTimes(2);
        expect(writeContract).toHaveBeenCalledTimes(1);
    });

    it("a failed send (transport error) is never retried — duplicate-send risk", async () => {
        const writeContract = vi.fn(async () => {
            throw new HttpRequestError({ url: "https://rpc.invalid", status: 503 });
        });
        const writer = createViemAgentWriter({
            walletClient: { writeContract } as never,
            publicClient: { waitForTransactionReceipt: async () => receipt, getBlock: laggingGetBlock(0) } as never,
            vault: VAULT,
            account: BY,
            chain: { id: 84532 } as never,
            retry: noSleep,
        });
        await expect(writer.spend({ requestId: 1n, merchant: BY, amount: 1n, agentReviewRequest: false, evidenceHash: EVIDENCE } as never)).rejects.toMatchObject({
            code: "CHAIN_RPC_ERROR",
        });
        expect(writeContract).toHaveBeenCalledTimes(1);
    });

    it("reader.getLogs: the range end is confirmed available before the scan, and a lagging getLogs/getBlock is retried", async () => {
        let logsCalls = 0;
        const getLogs = vi.fn(async () => {
            if (logsCalls++ < 1) throw new Error("RPC Request failed. Details: header not found");
            return [pausedLog()];
        });
        const getBlock = laggingGetBlock(1);
        const reader = createViemVaultReader({ client: { getLogs, getBlock } as never, vault: VAULT, chainId: 84532, retry: noSleep });

        const events = await reader.getLogs(BLOCK - 5n, BLOCK);

        expect(events.map((e) => [e.name, e.blockNumber, e.blockTimestamp])).toEqual([["VaultPaused", BLOCK, 1_700_000_000]]);
        expect(getBlock.mock.calls[0][0]).toEqual({ blockNumber: BLOCK });
        expect(getLogs).toHaveBeenCalledTimes(2);
    });

    it("reader.latestBlock: a 503 from the RPC is retried", async () => {
        let n = 0;
        const getBlockNumber = vi.fn(async () => {
            if (n++ < 1) throw new HttpRequestError({ url: "https://rpc.invalid", status: 503 });
            return BLOCK;
        });
        const reader = createViemVaultReader({ client: { getBlockNumber } as never, vault: VAULT, chainId: 84532, retry: noSleep });
        expect(await reader.latestBlock()).toBe(BLOCK);
        expect(getBlockNumber).toHaveBeenCalledTimes(2);
    });
});
