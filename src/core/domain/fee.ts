import { BPS_DENOMINATOR, FEE_BPS_MAX } from "@/config/constants";

/** Platform fee in payment-token units: floor(amount * feeBps / 10000) — same as PolicyVault.quoteFee (D-06). */
export function quoteFee(amount: bigint, feeBps: number): bigint {
    if (amount < 0n) throw new RangeError("amount must be >= 0");
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > FEE_BPS_MAX)
        throw new RangeError(`feeBps must be an integer in 0..${FEE_BPS_MAX}`);
    return (amount * BigInt(feeBps)) / BPS_DENOMINATOR;
}
