import { SECONDS_PER_DAY, SECONDS_PER_MINUTE } from "@/config/constants";
import { quoteFee } from "./fee";
import { BlockReason } from "./reasons";
import type { Hex, PrecheckResult, VaultStateSnapshot } from "./types";

const ZERO_ADDRESS = /^0x0{40}$/i;

export function remainingBudget(s: VaultStateSnapshot): bigint {
    const r = s.budget - s.spent - s.reserved;
    return r > 0n ? r : 0n;
}

function windowCount(storedBucket: bigint, storedCount: number, timestamp: number, size: number): number {
    return storedBucket === BigInt(Math.floor(timestamp / size)) ? storedCount : 0;
}

/**
 * Deterministic pre-check that mirrors PolicyVault.spend steps 1..9 in the same order
 * (Architecture "spend 판정 순서", D-11). It only decides whether Kiln is worth calling;
 * the contract makes the final decision. Inputs the contract reverts on (step 0) are programming errors here.
 */
export function evaluatePrecheck(s: VaultStateSnapshot, r: { merchant: Hex; amount: bigint }): PrecheckResult {
    if (r.amount <= 0n) throw new RangeError("amount must be > 0 (the contract reverts InvalidAmount)");
    if (ZERO_ADDRESS.test(r.merchant)) throw new RangeError("merchant must not be the zero address");

    const fee = quoteFee(r.amount, s.feeBps);
    const block = (reason: BlockReason): PrecheckResult => ({ verdict: "block", reason, fee });

    if (s.paused) return block(BlockReason.PAUSED);
    if (s.policyVersion === 0n) return block(BlockReason.NO_POLICY);
    if (s.blockTimestamp >= s.expiresAt) return block(BlockReason.EXPIRED);
    if (windowCount(s.minuteBucket, s.minuteCount, s.blockTimestamp, SECONDS_PER_MINUTE) >= s.maxPerMinute)
        return block(BlockReason.RATE_LIMIT_MINUTE);
    if (windowCount(s.dayBucket, s.dayCount, s.blockTimestamp, SECONDS_PER_DAY) >= s.maxPerDay)
        return block(BlockReason.RATE_LIMIT_DAY);

    const merchant = r.merchant.toLowerCase();
    if (!s.merchants.some((m) => m.toLowerCase() === merchant)) return block(BlockReason.MERCHANT_NOT_ALLOWED);
    if (r.amount + fee > remainingBudget(s)) return block(BlockReason.OVER_BUDGET);
    if (s.vaultBalance < r.amount + fee + s.reserved) return block(BlockReason.INSUFFICIENT_VAULT_BALANCE);

    return { verdict: "pass", expected: r.amount > s.approvalThreshold ? "pending" : "execute", fee };
}
