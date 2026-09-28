import {
    BaseError,
    BlockNotFoundError,
    ContractFunctionRevertedError,
    HttpRequestError,
    TimeoutError,
    TransactionNotFoundError,
    TransactionReceiptNotFoundError,
} from "viem";
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
        // "Transaction (receipt) … could not be found" is a definitive answer for an unknown hash, not node lag — it would
        // otherwise match LAGGING_NODE_MESSAGE. waitForTransactionReceipt polls for its own tx, so writes are unaffected.
        if (err.walk((e) => e instanceof TransactionReceiptNotFoundError || e instanceof TransactionNotFoundError)) return false;
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

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const RPC_MESSAGE_MAX = 160;

/**
 * JSON-RPC error code + the node's short message, for one-line CLI error logs. Walks `cause` (AppError wrappers too).
 * Never includes the request URL (a dedicated RPC URL carries an API key): viem keeps it in metaMessages, which we skip,
 * and any URL echoed in the node's own message is masked.
 */
export function rpcErrorInfo(err: unknown): { rpcCode: number; rpcMessage: string } | undefined {
    for (let e: unknown = err, depth = 0; e instanceof Error && depth < 10; e = (e as { cause?: unknown }).cause, depth++) {
        const code = (e as { code?: unknown }).code;
        if (typeof code !== "number") continue;
        const details = (e as { details?: unknown }).details;
        const raw = typeof details === "string" && details !== "" ? details : ((e as { shortMessage?: unknown }).shortMessage as string | undefined) ?? "";
        const rpcMessage = raw.split("\n")[0].replace(URL_IN_TEXT, "<url>").slice(0, RPC_MESSAGE_MAX);
        return { rpcCode: code, rpcMessage };
    }
    return undefined;
}
