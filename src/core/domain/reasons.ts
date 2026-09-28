// 1:1 with the REASON_* / FLAG_* constants in chain/contracts/PolicyVault.sol (checked by tests/unit/reasons.test.ts).
export enum BlockReason {
    NONE = 0,
    PAUSED = 1,
    NO_POLICY = 2,
    EXPIRED = 3,
    RATE_LIMIT_MINUTE = 4,
    RATE_LIMIT_DAY = 5,
    MERCHANT_NOT_ALLOWED = 6,
    OVER_BUDGET = 7,
    INSUFFICIENT_VAULT_BALANCE = 8,
}

export const PendingFlag = { OVER_THRESHOLD: 1, AGENT_REVIEW_REQUEST: 2 } as const;

const BLOCK_REASON_LABELS: Record<number, string> = {
    [BlockReason.PAUSED]: "Paused by owner",
    [BlockReason.NO_POLICY]: "No policy registered",
    [BlockReason.EXPIRED]: "Policy expired",
    [BlockReason.RATE_LIMIT_MINUTE]: "Too many attempts this minute",
    [BlockReason.RATE_LIMIT_DAY]: "Too many attempts today",
    [BlockReason.MERCHANT_NOT_ALLOWED]: "Merchant not allowed",
    [BlockReason.OVER_BUDGET]: "Over budget (incl. fee)",
    [BlockReason.INSUFFICIENT_VAULT_BALANCE]: "Vault balance too low",
};

const PENDING_FLAG_LABELS: [number, string][] = [
    [PendingFlag.OVER_THRESHOLD, "Above approval threshold"],
    [PendingFlag.AGENT_REVIEW_REQUEST, "AI flagged / review requested"],
];

export function blockReasonLabel(code: number): string {
    return BLOCK_REASON_LABELS[code] ?? `Unknown reason (${code})`;
}

export function pendingFlagLabels(flags: number): string[] {
    return PENDING_FLAG_LABELS.filter(([bit]) => (flags & bit) !== 0).map(([, label]) => label);
}
