// Single source of truth for numeric/text constants (CodingRules "설정 및 상수", Architecture "이 문서를 읽는 법").

export const FEE_BPS_MAX = 1000;
export const BPS_DENOMINATOR = 10_000n;

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_DAY = 86_400;
export const KST_OFFSET_SECONDS = 9 * 3600;

/** Architecture 3 "정책 검증 규칙". */
export const POLICY_RULES = {
    budgetMin: 1,
    budgetMax: 100_000_000,
    merchantsMin: 1,
    merchantsMax: 20,
    purposeMax: 200,
    rateLimitMax: 1000,
} as const;

/** Defaults for the owner-editable burst limits (D-07, 제안 — OQ #6). Not extracted by Kiln. */
export const DEFAULT_RATE_LIMITS = { maxPerMinute: 3, maxPerDay: 20 } as const;

export const INPUT_LIMITS = {
    delegationTextMax: 500,
    itemDescriptionMax: 200,
    intentReasonMax: 200,
} as const;

/** Architecture 4 "요청 본문" and D-19 retry rules. */
export const KILN = {
    defaultModel: "qwen3-32b",
    defaultMaxTokensParse: 2048,
    defaultMaxTokensJudge: 1024,
    minMaxTokens: 500,
    temperature: 0,
    timeoutMs: 90_000,
    maxAttempts: 4,
    backoffBaseMs: 1000,
    backoffCapMs: 8000,
    jitterMaxMs: 1000,
    rawContentMax: 4000,
    generationIdHeader: "x-neocloud-generation-id",
    rateLimitResetHeader: "x-ratelimit-reset",
} as const;

export const KILN_FUNCTION_NAMES = {
    policy: "submit_spending_policy",
    intent: "submit_intent_judgment",
} as const;

/** FakeKilnClient default judge rule (Architecture 4, FakeKilnClient). */
export const FAKE_INTENT_MISMATCH_PATTERN = /personal|gaming|개인/i;

export const EVIDENCE_SCHEMA = "agent-spend-evidence/v1";

export const SQLITE_USER_VERSION = 1;

/** VaultReader.getLogs chunk size (Architecture 7). */
export const LOG_BLOCK_CHUNK = 10_000n;

export const ZERO_HASH: `0x${string}` = "0x0000000000000000000000000000000000000000000000000000000000000000";
