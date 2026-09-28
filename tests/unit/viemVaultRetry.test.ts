import { BlockNotFoundError, HttpRequestError, RpcRequestError, TransactionReceiptNotFoundError, encodeAbiParameters, encodeEventTopics, getAddress, type Log } from "viem";
import { describe, expect, it, vi } from "vitest";
import { policyVaultAbi } from "@/adapters/chain/generated/PolicyVault";
import { rpcErrorInfo } from "@/adapters/chain/readRetry";
import { createViemAgentWriter, createViemVaultReader } from "@/adapters/chain/viemVault";
import { AppError } from "@/core/errors";

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

    it("reader.getReceiptEvents: an unknown tx hash (TransactionReceiptNotFoundError) → null after exactly one call, not retried", async () => {
        const getTransactionReceipt = vi.fn(async ({ hash }: { hash: `0x${string}` }) => {
            throw new TransactionReceiptNotFoundError({ hash });
        });
        const sleep = vi.fn(async () => {});
        const reader = createViemVaultReader({ client: { getTransactionReceipt } as never, vault: VAULT, chainId: 84532, retry: { sleep } });

        expect(await reader.getReceiptEvents(TX)).toBeNull();
        expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it("reader.getLogs: a 14,025-block range on an RPC limited to 1,000 blocks per eth_getLogs → every chunk within the limit", async () => {
        const from = 47_419_193n;
        const to = from + 14_025n;
        const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
            if (toBlock - fromBlock + 1n > 1_000n)
                throw new RpcRequestError({
                    body: { method: "eth_getLogs" },
                    error: { code: -32614, message: "eth_getLogs is limited to a 1,000 range" },
                    url: "https://rpc.invalid",
                });
            return toBlock === to ? [pausedLog(to)] : [];
        });
        const reader = createViemVaultReader({ client: { getLogs, getBlock: laggingGetBlock(0) } as never, vault: VAULT, chainId: 84532, retry: noSleep });

        const events = await reader.getLogs(from, to);

        expect(events.map((e) => e.blockNumber)).toEqual([to]);
        const ranges = getLogs.mock.calls.map(([a]) => [a.fromBlock, a.toBlock]);
        expect(ranges[0][0]).toBe(from);
        expect(ranges[ranges.length - 1][1]).toBe(to);
        for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1n);
    });
});

describe("rpcErrorInfo (src/adapters/chain/readRetry.ts) — diagnosable CLI error line without the RPC URL", () => {
    const rpcErr = () =>
        new RpcRequestError({
            body: { method: "eth_getLogs" },
            error: { code: -32614, message: "eth_getLogs is limited to a 1,000 range" },
            url: "https://base-sepolia.example/v2/SECRET_KEY_123",
        });

    it("returns the JSON-RPC code and short message, never the URL", () => {
        const info = rpcErrorInfo(rpcErr());
        expect(info).toEqual({ rpcCode: -32614, rpcMessage: "eth_getLogs is limited to a 1,000 range" });
        expect(JSON.stringify(info)).not.toContain("SECRET_KEY_123");
    });

    it("finds the RPC error through an AppError cause", () => {
        const wrapped = new AppError("CHAIN_RPC_ERROR", "could not read the vault from the RPC", true, { cause: rpcErr() });
        expect(rpcErrorInfo(wrapped)).toEqual({ rpcCode: -32614, rpcMessage: "eth_getLogs is limited to a 1,000 range" });
    });

    it("a URL echoed inside the node's message is masked; long messages are truncated", () => {
        const e = new RpcRequestError({ body: {}, error: { code: -32000, message: `bad https://x.example/k/SECRET ${"a".repeat(300)}` }, url: "https://rpc.invalid" });
        const info = rpcErrorInfo(e);
        expect(info?.rpcMessage).not.toContain("SECRET");
        expect(info?.rpcMessage.length).toBeLessThanOrEqual(160);
    });

    it("no RPC error in the chain → undefined", () => {
        expect(rpcErrorInfo(new Error("boom"))).toBeUndefined();
        expect(rpcErrorInfo("boom")).toBeUndefined();
    });
});
