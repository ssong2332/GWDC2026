import { BaseError, BlockNotFoundError, ContractFunctionRevertedError, HttpRequestError, TimeoutError } from "viem";
import { CHAIN_READ_RETRY } from "@/config/constants";

// Bounded retry for chain READS only (T-07). Never wrap a transaction send with this — a retried send can double-spend.

export type ReadRetryOptions = {
    maxAttempts: number;
    backoffBaseMs: number;
    backoffCapMs: number;
    totalWaitCapMs: number;
    sleep: (ms: number) => Promise<void>;
};

/** Node-lag / "block not yet known" wording across geth-family and other clients (message text, not error class). */
const LAGGING_NODE_MESSAGE = /could not be found|header not found|unknown block|block not found|beyond (the )?current head/i;

export function isTransientReadError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err instanceof BaseError) {
        if (err.walk((e) => e instanceof ContractFunctionRevertedError)) return false;
        if (err.walk((e) => e instanceof BlockNotFoundError || e instanceof TimeoutError)) return true;
        const http = err.walk((e) => e instanceof HttpRequestError) as HttpRequestError | null;
        if (http) return http.status === undefined || http.status === 429 || http.status >= 500;
    }
    return LAGGING_NODE_MESSAGE.test(err.message);
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withReadRetry<T>(fn: () => Promise<T>, opts: Partial<ReadRetryOptions> = {}): Promise<T> {
    const o: ReadRetryOptions = { ...CHAIN_READ_RETRY, sleep: realSleep, ...opts };
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!isTransientReadError(err) || attempt >= o.maxAttempts) throw err;
            const delay = Math.min(o.backoffCapMs, o.backoffBaseMs * 2 ** (attempt - 1));
            if (waited + delay > o.totalWaitCapMs) throw err;
            waited += delay;
            await o.sleep(delay);
        }
    }
}
