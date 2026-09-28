import fs from "node:fs";
import path from "node:path";
import { quoteFee } from "@/core/domain/fee";
import { evaluatePrecheck } from "@/core/domain/precheck";
import type { Hex, VaultStateSnapshot } from "@/core/domain/types";

// Builds the VaultStateSnapshot that the contract would expose right before each rule case's request,
// by replaying the fixture's setup with the same time model the contract test uses
// (rule-cases.json "timing": fresh UTC day, every transaction mines one block 1 second later).

export interface PolicySpec {
    budget: string;
    approvalThreshold: string;
    expiresInSeconds: number;
    maxPerMinute: number;
    maxPerDay: number;
    merchants: string[];
}
export interface SpendSpec {
    merchant: string;
    amount: string;
    agentReviewRequest?: boolean;
    advanceSecondsBefore?: number;
}
export interface RuleCase {
    id: string;
    setup?: {
        vaultBalance?: string;
        policy?: Partial<PolicySpec> | null;
        priorSpends?: SpendSpec[];
        paused?: boolean;
        advanceSeconds?: number;
    };
    request: SpendSpec;
    expected: { outcome: "executed" | "pending" | "blocked"; reason: number; flags: number; fee: string };
}
export interface RuleCaseFile {
    version: number;
    feeBps: number;
    defaults: { vaultBalance: string; policy: PolicySpec };
    cases: RuleCase[];
}

export const ruleCaseFile: RuleCaseFile = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../fixtures/rule-cases.json"), "utf8"),
);

export const MERCHANTS: Record<string, Hex> = {
    A: "0x00000000000000000000000000000000000000aa",
    B: "0x00000000000000000000000000000000000000bb",
    X: "0x00000000000000000000000000000000000000cc",
};

const DAY_START = 20_000 * 86_400;

export function snapshotBeforeRequest(c: RuleCase): VaultStateSnapshot {
    const setup = c.setup ?? {};
    let t = DAY_START;
    const s: VaultStateSnapshot = {
        chainId: 31337,
        vault: "0x0000000000000000000000000000000000000001",
        paused: false,
        policyVersion: 0n,
        budget: 0n,
        spent: 0n,
        reserved: 0n,
        approvalThreshold: 0n,
        expiresAt: 0,
        maxPerMinute: 0,
        maxPerDay: 0,
        minuteBucket: 0n,
        minuteCount: 0,
        dayBucket: 0n,
        dayCount: 0,
        pendingCount: 0,
        vaultBalance: 0n,
        feeBps: ruleCaseFile.feeBps,
        merchants: [],
        blockTimestamp: t,
        blockNumber: 1n,
    };
    const mine = (seconds = 1) => {
        t += seconds;
        s.blockTimestamp = t;
        s.blockNumber += 1n;
    };

    mine();
    s.vaultBalance = BigInt(setup.vaultBalance ?? ruleCaseFile.defaults.vaultBalance);

    if (setup.policy !== null) {
        mine();
        const p = { ...ruleCaseFile.defaults.policy, ...(setup.policy ?? {}) };
        s.policyVersion = 1n;
        s.budget = BigInt(p.budget);
        s.approvalThreshold = BigInt(p.approvalThreshold);
        s.expiresAt = DAY_START + p.expiresInSeconds;
        s.maxPerMinute = p.maxPerMinute;
        s.maxPerDay = p.maxPerDay;
        s.merchants = p.merchants.map((m) => MERCHANTS[m]);
        s.spent = 0n;
    }

    for (const prior of setup.priorSpends ?? []) {
        if (prior.advanceSecondsBefore) mine(prior.advanceSecondsBefore);
        mine();
        applySpend(s, prior);
    }
    if (setup.paused) {
        mine();
        s.paused = true;
    }
    if (setup.advanceSeconds) mine(setup.advanceSeconds);
    mine();
    return s;
}

// State effects of one mined spend (Architecture "spend 판정 순서"): the minute/day windows count every
// attempt that passed steps 1..5, pending reserves amount+fee, execution moves amount+fee out of the vault.
function applySpend(s: VaultStateSnapshot, sp: SpendSpec): void {
    const amount = BigInt(sp.amount);
    const r = evaluatePrecheck(s, { merchant: MERCHANTS[sp.merchant], amount });
    const passedWindows = r.verdict === "pass" || r.reason >= 6;
    if (passedWindows) {
        const minute = BigInt(Math.floor(s.blockTimestamp / 60));
        const day = BigInt(Math.floor(s.blockTimestamp / 86_400));
        s.minuteCount = (s.minuteBucket === minute ? s.minuteCount : 0) + 1;
        s.minuteBucket = minute;
        s.dayCount = (s.dayBucket === day ? s.dayCount : 0) + 1;
        s.dayBucket = day;
    }
    if (r.verdict === "block") return;
    const total = amount + quoteFee(amount, s.feeBps);
    if (r.expected === "pending" || sp.agentReviewRequest) {
        s.reserved += total;
        s.pendingCount += 1;
    } else {
        s.spent += total;
        s.vaultBalance -= total;
    }
}
