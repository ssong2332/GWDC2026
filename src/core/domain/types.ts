import type { BlockReason } from "./reasons";

export type Hex = `0x${string}`;

export type MerchantEntry = { id: string; displayName: string; aliases: string[]; address: Hex };

export type PolicyValues = {
    budget: bigint;
    approvalThreshold: bigint;
    expiresAt: number;
    maxPerMinute: number;
    maxPerDay: number;
    merchantIds: string[];
    purpose: string;
};

export type PolicyCandidate = {
    budget: bigint;
    approvalThreshold: bigint;
    merchantIds: string[];
    expiresOn: string | null;
    purpose: string;
    unrecognizedMerchants: string[];
};

export type VaultStateSnapshot = {
    chainId: number;
    vault: Hex;
    paused: boolean;
    policyVersion: bigint;
    budget: bigint;
    spent: bigint;
    reserved: bigint;
    approvalThreshold: bigint;
    expiresAt: number;
    maxPerMinute: number;
    maxPerDay: number;
    minuteBucket: bigint;
    minuteCount: number;
    dayBucket: bigint;
    dayCount: number;
    pendingCount: number;
    vaultBalance: bigint;
    feeBps: number;
    merchants: Hex[];
    blockTimestamp: number;
    blockNumber: bigint;
};

export type SpendRequestInput = { merchantId: string; amount: bigint; itemDescription: string };

export type PrecheckResult =
    | { verdict: "pass"; expected: "execute" | "pending"; fee: bigint }
    | { verdict: "block"; reason: BlockReason; fee: bigint };

export type IntentJudgment = {
    status: "match" | "mismatch" | "invalid_output" | "error";
    reason: string;
    kilnCallId: string;
};

export type SpendOutcome = {
    requestId: Hex;
    flow: "rule_block" | "intent_judge";
    txHash: Hex;
    outcome: "executed" | "blocked" | "pending";
    blockReason: BlockReason | null;
    pendingFlags: number | null;
    evidenceHash: Hex;
    kilnCalls: 0 | 1;
    precheckAgreed: boolean;
};

export type KilnFlow = "policy_parse" | "intent_judge";

export type KilnErrorCode =
    | "KILN_RATE_LIMITED"
    | "KILN_CREDIT_EXHAUSTED"
    | "KILN_AUTH"
    | "KILN_BAD_REQUEST"
    | "KILN_UNAVAILABLE";

/** Result of one Kiln call as seen by the use cases (Architecture 4. KilnCallResult.outcome). */
export type KilnOutcome =
    | { kind: "tool_call"; functionName: string; rawArguments: string }
    | { kind: "no_tool_call"; content: string }
    // status 0 = no HTTP response at all (network error or timeout after the last attempt)
    | { kind: "http_error"; status: number; code: string | null };
