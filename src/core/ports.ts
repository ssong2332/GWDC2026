import type { Anchor } from "./domain/evidence";
import type { Hex, KilnFlow, KilnOutcome, MerchantEntry, VaultStateSnapshot } from "./domain/types";

// External dependencies of the use cases (Architecture 4 and 7). Implementations live in src/adapters/*.

export type KilnCallRecord = {
    callId: string;
    flow: KilnFlow;
    provider: "kiln" | "fake";
    model: string;
    httpStatus: number | null;
    finishReason: string | null;
    attempts: number;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number | null;
    totalTokens: number;
    cachedTokens: number | null;
    costUsd: string | null;
    generationId: string | null;
    thinkingMode: "default" | "kwargs_off" | "no_think";
    createdAt: string;
};

/** Always returned — failures are records too. Clients never throw for HTTP/network failures. */
export type KilnCallResult = { record: KilnCallRecord; outcome: KilnOutcome };

export interface KilnClient {
    parsePolicy(i: { delegationText: string; todayKst: string; merchants: MerchantEntry[] }): Promise<KilnCallResult>;
    judgeIntent(i: {
        purpose: string;
        delegationText: string;
        merchantName: string;
        amount: bigint;
        itemDescription: string;
    }): Promise<KilnCallResult>;
}

export type DecodedVaultEvent = {
    name: string;
    txHash: Hex;
    logIndex: number;
    blockNumber: bigint;
    blockTimestamp: number;
    args: Record<string, unknown>;
};

export interface VaultReader {
    getState(): Promise<VaultStateSnapshot>;
    remainingBudget(): Promise<bigint>;
    getPending(requestId: Hex): Promise<{
        merchant: Hex;
        amount: bigint;
        fee: bigint;
        flags: number;
        status: number;
        evidenceHash: Hex;
    }>;
    getReceiptEvents(
        txHash: Hex,
    ): Promise<{ status: "success" | "reverted"; blockNumber: bigint; events: DecodedVaultEvent[] } | null>;
    getLogs(fromBlock: bigint, toBlock: bigint): Promise<DecodedVaultEvent[]>;
    latestBlock(): Promise<bigint>;
}

export interface AgentVaultWriter {
    spend(a: { requestId: Hex; merchant: Hex; amount: bigint; agentReviewRequest: boolean; evidenceHash: Hex }): Promise<{
        txHash: Hex;
        receipt: { status: "success" | "reverted"; events: DecodedVaultEvent[]; gasUsed: bigint; feeWei: bigint };
    }>;
}

export type EvidenceRow = {
    evidenceId: string;
    kind: string;
    chainId: number;
    vault: Hex;
    requestId: Hex | null;
    packageJson: string;
    evidenceHash: Hex;
    createdAt: string;
    anchor: Anchor;
    anchoredAt: string | null;
};

export interface EvidenceRepo {
    insert(r: {
        evidenceId: string;
        kind: string;
        chainId: number;
        vault: Hex;
        requestId: Hex | null;
        packageJson: string;
        evidenceHash: Hex;
        createdAt: string;
    }): void;
    findByHash(h: Hex): EvidenceRow | null;
    findById(id: string): EvidenceRow | null;
    listByRequestId(id: Hex): EvidenceRow[];
    setAnchor(h: Hex, a: NonNullable<Anchor>): void;
    listByVault(chainId: number, vault: Hex): EvidenceRow[];
}

export type KilnCallInsert = KilnCallRecord & {
    chainId: number;
    vault: Hex;
    requestId: Hex | null;
    status: KilnOutcome["kind"];
    errorCode: string | null;
    rawArguments: string | null;
    rawContent: string | null;
};

// aggregateByFlow (Architecture 7) is left to the efficiency-report task: its FlowAggregate type is not defined yet.
export interface KilnCallRepo {
    insert(r: KilnCallInsert): void;
    findById(id: string): KilnCallRecord | null;
}

export type SpendRequestRow = {
    requestId: Hex;
    evidenceId: string;
    chainId: number;
    vault: Hex;
    flow: "rule_block" | "intent_judge";
    merchantId: string;
    amount: bigint;
    fee: bigint;
    precheckVerdict: "pass" | "block";
    precheckReason: number | null;
    judgmentStatus: string | null;
    txHash: Hex | null;
    outcome: "executed" | "blocked" | "pending" | "failed" | null;
    onchainReason: number | null;
    pendingFlags: number | null;
    createdAt: string;
};

export interface SpendRequestRepo {
    insert(r: SpendRequestRow): void;
    updateOutcome(
        requestId: Hex,
        o: Partial<Pick<SpendRequestRow, "txHash" | "outcome" | "onchainReason" | "pendingFlags">>,
    ): void;
    countByFlow(chainId: number, vault: Hex): { flow: string; n: number }[];
}

export interface Clock {
    now(): Date;
}
