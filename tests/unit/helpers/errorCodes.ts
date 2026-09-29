// Every error code the screens can show (Architecture 에러 처리): API codes, client/wallet codes, PolicyVault custom
// errors surfaced by simulation. Shared by errorMessages.test.ts and i18nMessages.test.ts (F-17 ⑦ coverage).

export const API_CODES = [
    "VALIDATION_FAILED",
    "SCHEMA_INVALID",
    "NO_TOOL_CALL",
    "INVALID_ARGS",
    "UNKNOWN_MERCHANT",
    "EXPIRY_REQUIRED",
    "NOT_OWNER",
    "NOT_FOUND",
    "KILN_RATE_LIMITED",
    "KILN_CREDIT_EXHAUSTED",
    "KILN_UNAVAILABLE",
    "KILN_AUTH",
    "KILN_BAD_REQUEST",
    "CHAIN_RPC_ERROR",
    "INTERNAL",
];
export const CLIENT_CODES = ["NETWORK_ERROR", "BAD_RESPONSE", "SIGNATURE_REJECTED", "WRONG_NETWORK", "WALLET_ERROR", "NO_WALLET", "TX_REVERTED"];
export const CONTRACT_CODES = [
    "CONTRACT_NOT_OWNER",
    "CONTRACT_PENDING_EXISTS",
    "CONTRACT_PENDING_NOT_FOUND",
    "CONTRACT_VAULT_IS_PAUSED",
    "CONTRACT_POLICY_EXPIRED",
    "CONTRACT_ALREADY_PAUSED",
    "CONTRACT_NOT_PAUSED",
    "CONTRACT_INVALID_POLICY",
    "CONTRACT_REVERTED",
];
