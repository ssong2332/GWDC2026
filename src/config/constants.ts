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

/** pause/unpause evidence note length (Architecture 5: 0..200, empty allowed). */
export const OWNER_NOTE_MAX = 200;

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
export const EVIDENCE_EXPORT_SCHEMA = "agent-spend-evidence-export/v1";

export const SQLITE_USER_VERSION = 1;

/** VaultReader.getLogs chunk size (Architecture 7). */
export const LOG_BLOCK_CHUNK = 10_000n;

export const ZERO_HASH: `0x${string}` = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Defaults when a variable is unset (Architecture `.env.example` 변수 목록). Tests and e2e:local run without env files. */
export const ENV_DEFAULTS = {
    rpcUrl: "http://127.0.0.1:8545",
    databasePath: "data.local/app.sqlite",
    kilnBaseUrl: "https://api.bricksum.com/v1",
} as const;

/** E2E step 0 / cli/deploy.ts (Architecture E2E 시나리오, D-06): 1% fee, vault funded with 1,000,000 mKRW. */
export const DEPLOY_DEFAULTS = { feeBps: 100, vaultMint: 1_000_000n } as const;

/** HTTP API input bounds (Route Handlers). Domain rules (policy ranges etc.) are checked by the use cases. */
export const API_LIMITS = { decimalDigitsMax: 30, idMax: 100, listMax: 50 } as const;

/** /api/owner-actions/confirm: how long the server waits for the owner's tx receipt and its events (Architecture 데이터 흐름 A-5). */
export const OWNER_CONFIRM = { timeoutMs: 60_000, pollMs: 1_000 } as const;

/** Dashboard refresh interval (Architecture 10 "서버 데이터 상태": 5초 폴링). */
export const DASHBOARD_POLL_MS = 5_000;

/** Default RPC for cli/verify-evidence.ts by chain id (public Base Sepolia RPC; local Hardhat node). */
export const DEFAULT_VERIFY_RPC: Record<number, string> = {
    31337: "http://127.0.0.1:8545",
    84532: "https://sepolia.base.org",
};

/**
 * Chain READ retry (T-07): a load-balanced public RPC can answer from a node that has not seen a fresh block yet
 * (BlockNotFound / "header not found") or fail transiently (HTTP 429/5xx, timeout). Exponential backoff
 * base·2^(n−1) capped per step; stops at maxAttempts OR when the summed wait would exceed totalWaitCapMs.
 * Delays: 250, 500, 1000, 2000, 2000 ms = 5.75 s ≤ 8 s. Writes (tx sends) are never retried (duplicate-send risk).
 */
export const CHAIN_READ_RETRY = { maxAttempts: 6, backoffBaseMs: 250, backoffCapMs: 2000, totalWaitCapMs: 8000 } as const;
