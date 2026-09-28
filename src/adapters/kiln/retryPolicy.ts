import { KILN } from "@/config/constants";
import type { KilnErrorCode } from "@/core/domain/types";

// D-19 / PRD N-05. status 0 = no HTTP response (network error or timeout).

export function isRetryable(status: number): boolean {
    return status === 0 || status === 429 || status >= 500;
}

/** Wait before the next attempt, after `attempt` (1-based) failed. */
export function retryDelayMs(attempt: number, status: number, resetHeader: string | null, random: () => number): number {
    const jitter = Math.floor(random() * KILN.jitterMaxMs);
    const reset = resetHeader === null ? NaN : Number(resetHeader);
    if (status === 429 && Number.isFinite(reset) && reset >= 0) return Math.ceil(reset * 1000) + jitter;
    return Math.min(KILN.backoffBaseMs * 2 ** (attempt - 1), KILN.backoffCapMs) + jitter;
}

export function errorCodeFor(status: number): KilnErrorCode {
    if (status === 429) return "KILN_RATE_LIMITED";
    if (status === 402) return "KILN_CREDIT_EXHAUSTED";
    if (status === 401 || status === 403) return "KILN_AUTH";
    if (status === 0 || status >= 500) return "KILN_UNAVAILABLE";
    return "KILN_BAD_REQUEST";
}
