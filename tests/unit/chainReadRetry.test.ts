import { BaseError, BlockNotFoundError, ContractFunctionRevertedError, HttpRequestError, TimeoutError } from "viem";
import { describe, expect, it, vi } from "vitest";
import { isTransientReadError, withReadRetry } from "@/adapters/chain/readRetry";
import { CHAIN_READ_RETRY } from "@/config/constants";

const notFound = () => new BlockNotFoundError({ blockNumber: 7n });

function failing(times: number, make: () => Error = notFound) {
    let n = 0;
    return vi.fn(async () => {
        if (n++ < times) throw make();
        return "ok";
    });
}

describe("withReadRetry (src/adapters/chain/readRetry.ts, T-07)", () => {
    it("returns on the first success without sleeping", async () => {
        const sleep = vi.fn(async () => {});
        const fn = failing(0);
        expect(await withReadRetry(fn, { sleep })).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it("succeeds on the last allowed attempt with exponential, capped backoff (250, 500, 1000, 2000, 2000)", async () => {
        const sleeps: number[] = [];
        const fn = failing(CHAIN_READ_RETRY.maxAttempts - 1);
        expect(await withReadRetry(fn, { sleep: async (ms) => void sleeps.push(ms) })).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(CHAIN_READ_RETRY.maxAttempts);
        expect(sleeps).toEqual([250, 500, 1000, 2000, 2000]);
        expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(CHAIN_READ_RETRY.totalWaitCapMs);
    });

    it("gives up after maxAttempts and rethrows the original error", async () => {
        const fn = failing(100);
        await expect(withReadRetry(fn, { sleep: async () => {} })).rejects.toBeInstanceOf(BlockNotFoundError);
        expect(fn).toHaveBeenCalledTimes(CHAIN_READ_RETRY.maxAttempts);
    });

    it("stops before exceeding the total wait cap even if attempts remain", async () => {
        const sleeps: number[] = [];
        const fn = failing(100);
        await expect(withReadRetry(fn, { totalWaitCapMs: 800, sleep: async (ms) => void sleeps.push(ms) })).rejects.toBeInstanceOf(BlockNotFoundError);
        expect(sleeps).toEqual([250, 500]);
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("does not retry a contract revert", async () => {
        const revert = () => new BaseError("call failed", { cause: new ContractFunctionRevertedError({ abi: [], functionName: "spend" }) });
        const fn = failing(1, revert);
        await expect(withReadRetry(fn, { sleep: async () => {} })).rejects.toBeInstanceOf(BaseError);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("does not retry an input/client error (HTTP 400, plain Error)", async () => {
        const bad = failing(1, () => new HttpRequestError({ url: "https://rpc.invalid", status: 400 }));
        await expect(withReadRetry(bad, { sleep: async () => {} })).rejects.toBeInstanceOf(HttpRequestError);
        expect(bad).toHaveBeenCalledTimes(1);
        const plain = failing(1, () => new Error("invalid address"));
        await expect(withReadRetry(plain, { sleep: async () => {} })).rejects.toThrow("invalid address");
        expect(plain).toHaveBeenCalledTimes(1);
    });
});

describe("isTransientReadError classification", () => {
    it.each([
        ["BlockNotFoundError", notFound(), true],
        ["timeout", new TimeoutError({ body: {}, url: "https://rpc.invalid" }), true],
        ["HTTP 429", new HttpRequestError({ url: "u", status: 429 }), true],
        ["HTTP 503", new HttpRequestError({ url: "u", status: 503 }), true],
        ["network error (no status)", new HttpRequestError({ url: "u" }), true],
        ["'header not found' RPC text", new Error("Details: header not found"), true],
        ["HTTP 401", new HttpRequestError({ url: "u", status: 401 }), false],
        ["execution reverted text", new Error("execution reverted"), false],
        ["non-Error value", "boom", false],
    ])("%s → %s", (_label, err, expected) => {
        expect(isTransientReadError(err)).toBe(expected);
    });
});
