// Event replay (Architecture 5, check R): was every executed payment inside the policy that was active at the time?
// Pure — the verifier feeds it the vault's on-chain events. Amounts may be bigint or decimal strings.

export type ReplayEvent = {
    name: string;
    txHash: string;
    logIndex: number;
    blockNumber: bigint;
    blockTimestamp: number;
    args: Record<string, unknown>;
};

export type ReplayProblem = "NO_POLICY" | "MERCHANT_NOT_ALLOWED" | "OVER_BUDGET" | "EXPIRED" | "APPROVAL_MISSING";

export type ReplayViolation = { txHash: string; logIndex: number; requestId: string; problems: ReplayProblem[] };

type ActivePolicy = { budget: bigint; threshold: bigint; expiresAt: bigint; merchants: Set<string> };

const big = (v: unknown): bigint => BigInt(String(v));
const lower = (v: unknown): string => String(v).toLowerCase();

export function replayPolicy(events: ReplayEvent[]): ReplayViolation[] {
    const ordered = [...events].sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    );
    let policy: ActivePolicy | null = null;
    let spent = 0n;
    const approved = new Set<string>();
    const violations: ReplayViolation[] = [];

    for (const e of ordered) {
        if (e.name === "PolicySet") {
            policy = {
                budget: big(e.args.budget),
                threshold: big(e.args.approvalThreshold),
                expiresAt: big(e.args.expiresAt),
                merchants: new Set((e.args.merchants as unknown[]).map(lower)),
            };
            spent = 0n; // setPolicy resets spent
        } else if (e.name === "Approved") {
            approved.add(lower(e.args.requestId));
        } else if (e.name === "SpendExecuted") {
            const requestId = lower(e.args.requestId);
            const amount = big(e.args.amount);
            const problems: ReplayProblem[] = [];
            if (!policy) problems.push("NO_POLICY");
            else {
                if (!policy.merchants.has(lower(e.args.merchant))) problems.push("MERCHANT_NOT_ALLOWED");
                if (spent + amount + big(e.args.fee) > policy.budget) problems.push("OVER_BUDGET");
                if (BigInt(e.blockTimestamp) >= policy.expiresAt) problems.push("EXPIRED");
                if (amount > policy.threshold && !approved.has(requestId)) problems.push("APPROVAL_MISSING");
            }
            spent += amount + big(e.args.fee);
            if (problems.length > 0) violations.push({ txHash: e.txHash, logIndex: e.logIndex, requestId: String(e.args.requestId), problems });
        }
    }
    return violations;
}
