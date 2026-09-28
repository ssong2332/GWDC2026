import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import type { Address } from "viem";
import {
    alignToNextDay,
    deployVault,
    hashOf,
    mintToVault,
    ownerToggle,
    setPolicy,
    spend,
    type VaultFixture,
} from "./helpers/vault";

interface PolicySpec {
    budget: string;
    approvalThreshold: string;
    expiresInSeconds: number;
    maxPerMinute: number;
    maxPerDay: number;
    merchants: string[];
}

interface SpendSpec {
    merchant: string;
    amount: string;
    agentReviewRequest?: boolean;
    advanceSecondsBefore?: number;
}

interface RuleCase {
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

interface RuleCaseFile {
    version: number;
    feeBps: number;
    defaults: { vaultBalance: string; policy: PolicySpec };
    cases: RuleCase[];
}

const FIXTURE_PATH = path.resolve(__dirname, "../../tests/fixtures/rule-cases.json");
const file: RuleCaseFile = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

const OUTCOME_BY_EVENT: Record<string, RuleCase["expected"]["outcome"]> = {
    SpendExecuted: "executed",
    SpendPending: "pending",
    SpendBlocked: "blocked",
};

function merchantAddress(f: VaultFixture, symbol: string): Address {
    const map: Record<string, Address> = {
        A: f.merchantA.account.address,
        B: f.merchantB.account.address,
        X: f.merchantX.account.address,
    };
    const addr = map[symbol];
    if (!addr) throw new Error(`unknown merchant symbol ${symbol}`);
    return addr;
}

async function runCase(c: RuleCase) {
    const f = await loadFixture(deployVault);
    const dayStart = await alignToNextDay();
    const setup = c.setup ?? {};

    await mintToVault(f, BigInt(setup.vaultBalance ?? file.defaults.vaultBalance));
    if (setup.policy !== null) {
        const p = { ...file.defaults.policy, ...(setup.policy ?? {}) };
        await setPolicy(f, {
            budget: BigInt(p.budget),
            approvalThreshold: BigInt(p.approvalThreshold),
            expiresAt: BigInt(dayStart + p.expiresInSeconds),
            maxPerMinute: p.maxPerMinute,
            maxPerDay: p.maxPerDay,
            merchants: p.merchants.map((m) => merchantAddress(f, m)),
        });
    }
    for (const [i, s] of (setup.priorSpends ?? []).entries()) {
        if (s.advanceSecondsBefore) await time.increase(s.advanceSecondsBefore);
        await spend(f, {
            requestId: hashOf(`${c.id}:prior:${i}`),
            merchant: merchantAddress(f, s.merchant),
            amount: BigInt(s.amount),
            agentReviewRequest: s.agentReviewRequest ?? false,
        });
    }
    if (setup.paused) await ownerToggle(f, "pause", hashOf(`${c.id}:pause`));
    if (setup.advanceSeconds) await time.increase(setup.advanceSeconds);

    const { logs } = await spend(f, {
        requestId: hashOf(`${c.id}:request`),
        merchant: merchantAddress(f, c.request.merchant),
        amount: BigInt(c.request.amount),
        agentReviewRequest: c.request.agentReviewRequest ?? false,
    });
    expect(logs, "exactly one spend event").to.have.length(1);
    const log = logs[0] as { eventName: string; args: Record<string, unknown> };
    return {
        outcome: OUTCOME_BY_EVENT[log.eventName] ?? log.eventName,
        reason: (log.args.reason as number | undefined) ?? 0,
        flags: (log.args.flags as number | undefined) ?? 0,
        fee: String(log.args.fee),
    };
}

describe("rule-cases.json parity (contract side)", function () {
    it("fixture is well-formed: version 1, fee 1%, unique ids, covers every reason 1..8 and flags 1..3", function () {
        expect(file.version).to.equal(1);
        expect(file.feeBps).to.equal(100);
        const ids = file.cases.map((c) => c.id);
        expect(new Set(ids).size).to.equal(ids.length);
        const reasons = new Set(file.cases.filter((c) => c.expected.outcome === "blocked").map((c) => c.expected.reason));
        expect([...reasons].sort()).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8]);
        const flags = new Set(file.cases.filter((c) => c.expected.outcome === "pending").map((c) => c.expected.flags));
        expect([...flags].sort()).to.deep.equal([1, 2, 3]);
    });

    for (const c of file.cases) {
        it(`${c.id} → ${c.expected.outcome}${c.expected.reason ? ` reason ${c.expected.reason}` : ""}${c.expected.flags ? ` flags ${c.expected.flags}` : ""}`, async function () {
            expect(await runCase(c)).to.deep.equal(c.expected);
        });
    }
});
