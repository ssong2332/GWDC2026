import canonicalize from "canonicalize";
import { keccak256, stringToBytes } from "viem";
import type { Hex, IntentJudgment } from "./types";

// Evidence package (Architecture 5). The canonical JSON of the package is what gets hashed and stored;
// tx data lives outside the hash in `anchor` so the hash can be put into the tx itself.

export type EvidenceBase = { schema: "agent-spend-evidence/v1"; chainId: number; vault: Hex; createdAt: string };

export type KilnRef = {
    callId: string;
    provider: "kiln" | "fake";
    model: string;
    generationId: string | null;
    finishReason: string | null;
    usage: {
        promptTokens: number;
        completionTokens: number;
        reasoningTokens: number | null;
        totalTokens: number;
        costUsd: string | null;
    };
    rawArguments: string | null;
};

export type SpendRequestEvidence = EvidenceBase & {
    kind: "spend_request";
    requestId: Hex;
    policyVersion: string;
    policyEvidenceHash: Hex;
    request: { merchantId: string; merchantAddress: Hex; amount: string; fee: string; itemDescription: string };
    precheck: {
        verdict: "pass" | "block";
        reason: number | null;
        expected: "execute" | "pending" | null;
        snapshot: {
            blockNumber: string;
            blockTimestamp: number;
            remaining: string;
            paused: boolean;
            minuteCount: number;
            dayCount: number;
        };
    };
    judgment: null | { status: IntentJudgment["status"]; reason: string; kiln: KilnRef };
    submission: { agentReviewRequest: boolean };
};

export type PolicySetEvidence = EvidenceBase & {
    kind: "policy_set";
    owner: Hex;
    delegationText: string;
    kiln: KilnRef | null;
    candidate: unknown;
    final: {
        budget: string;
        approvalThreshold: string;
        expiresAt: number;
        expiresAtSource: "kiln" | "owner";
        maxPerMinute: number;
        maxPerDay: number;
        purpose: string;
        merchants: { id: string; displayName: string; address: Hex }[];
    };
    ownerEdits: string[];
    feeBps: number;
};

export type EvidencePackage =
    | PolicySetEvidence
    | SpendRequestEvidence
    | (EvidenceBase & { kind: "approval" | "rejection"; requestId: Hex; requestEvidenceHash: Hex; owner: Hex })
    | (EvidenceBase & { kind: "pause" | "unpause"; owner: Hex; note: string });

export type Anchor = {
    txHash: Hex;
    blockNumber: string;
    logIndex: number;
    event: string;
    args: Record<string, string | number | boolean | string[]>;
} | null;

function assertJcsSafe(value: unknown, path: string): void {
    const t = typeof value;
    if (value === null || t === "string" || t === "boolean") return;
    if (t === "number") {
        if (!Number.isFinite(value as number)) throw new TypeError(`${path}: non-finite number`);
        return;
    }
    if (t === "bigint") throw new TypeError(`${path}: bigint — convert to a decimal string first`);
    if (t === "undefined" || t === "function" || t === "symbol") throw new TypeError(`${path}: ${t} is not JSON`);
    if (Array.isArray(value)) {
        value.forEach((v, i) => assertJcsSafe(v, `${path}[${i}]`));
        return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertJcsSafe(v, `${path}.${k}`);
}

/** RFC 8785 (JCS) canonical JSON. Rejects values that JSON would silently drop or cannot represent. */
export function canonicalJson(value: unknown): string {
    assertJcsSafe(value, "$");
    const out = canonicalize(value);
    if (out === undefined) throw new TypeError("value cannot be canonicalized");
    return out;
}

export function hashCanonical(canonical: string): Hex {
    return keccak256(stringToBytes(canonical));
}

/** evidenceHash = keccak256(utf8(canonicalJSON(package))) (Architecture 5, D-13). */
export function hashPackage(pkg: unknown): { canonical: string; hash: Hex } {
    const canonical = canonicalJson(pkg);
    return { canonical, hash: hashCanonical(canonical) };
}

/** Export file (Architecture 5 "내보내기 파일") — the only input of the third-party verifier. */
export type EvidenceExportRecord = { evidenceId: string; kind: string; evidenceHash: Hex; package: unknown; anchor: Anchor };

export type EvidenceExport = {
    schema: "agent-spend-evidence-export/v1";
    network: "localhost" | "baseSepolia";
    chainId: number;
    vault: Hex;
    token: Hex;
    deployBlock: string;
    exportedAt: string;
    records: EvidenceExportRecord[];
    kilnCalls: KilnCallExport[];
};

/** KilnCallRecord (Architecture 4) as exported — same fields, plain JSON. */
export type KilnCallExport = {
    callId: string;
    flow: "policy_parse" | "intent_judge";
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
