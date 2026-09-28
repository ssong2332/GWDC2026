import type Database from "better-sqlite3";
import { getAddress, parseEventLogs, type Hex } from "viem";
import { hardhat } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyVaultAbi } from "@/adapters/chain/generated/PolicyVault";
import { createViemAgentWriter, createViemVaultReader } from "@/adapters/chain/viemVault";
import { createChainEventRepo } from "@/adapters/db/chainEventRepo";
import { createEvidenceRepo } from "@/adapters/db/evidenceRepo";
import { createKilnCallRepo } from "@/adapters/db/kilnCallRepo";
import { openDatabase } from "@/adapters/db/sqlite";
import { createSpendRequestRepo } from "@/adapters/db/spendRequestRepo";
import { FakeKilnClient, queueHandler, type FakeReply } from "@/adapters/kiln/fakeKilnClient";
import { ZERO_HASH } from "@/config/constants";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import { hashCanonical, type SpendRequestEvidence } from "@/core/domain/evidence";
import { AppError } from "@/core/errors";
import type { VaultReader } from "@/core/ports";
import { processSpendRequest, type ProcessSpendDeps } from "@/core/usecases/processSpendRequest";
import {
    DEMO_DELEGATION,
    DEMO_PURPOSE,
    agentNonce,
    deployVault,
    freshMinute,
    ownerCall,
    pause,
    publicClient,
    registerPolicy,
    tokenBalance,
    walletClient,
    type Deployed,
} from "./helpers/chain";

const addr = (id: string) => getAddress(MERCHANT_REGISTRY.find((m) => m.id === id)!.address);

const judge = (fits: boolean, reason = fits ? "Fits the event." : "Personal item, not for the event."): FakeReply => ({
    toolCall: { name: "submit_intent_judgment", arguments: { fits_purpose: fits, reason } },
    usage: { promptTokens: 410, completionTokens: 120, reasoningTokens: 80, costUsd: "0.00012" },
    generationId: `gen-judge-${fits}`,
});

let db: Database.Database;
beforeEach(async () => {
    db = openDatabase(":memory:");
    await freshMinute();
});
afterEach(() => db.close());

function depsFor(d: Deployed, replies: FakeReply[], over: Partial<ProcessSpendDeps> = {}) {
    const kiln = new FakeKilnClient(queueHandler(replies));
    const deps: ProcessSpendDeps = {
        chainId: hardhat.id,
        vault: getAddress(d.vault),
        deployBlock: d.deployBlock,
        reader: createViemVaultReader({ client: publicClient, vault: d.vault, chainId: hardhat.id }),
        writer: createViemAgentWriter({ walletClient, publicClient, vault: d.vault, account: d.agent, chain: hardhat }),
        kiln,
        evidence: createEvidenceRepo(db),
        kilnCalls: createKilnCallRepo(db),
        spendRequests: createSpendRequestRepo(db),
        chainEvents: createChainEventRepo(db),
        merchants: MERCHANT_REGISTRY,
        clock: { now: () => new Date() },
        ...over,
    };
    return { kiln, deps };
}

async function ready(policy: Parameters<typeof registerPolicy>[2] = {}) {
    const d = await deployVault();
    const { policyEvidenceHash } = await registerPolicy(d, createEvidenceRepo(db), policy);
    return { d, policyEvidenceHash };
}

/** Reads the tx receipt independently of the adapter under test. */
async function spendEventOf(txHash: Hex) {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const events = parseEventLogs({ abi: policyVaultAbi, logs: receipt.logs }).filter((e) =>
        ["SpendExecuted", "SpendBlocked", "SpendPending"].includes(e.eventName),
    );
    expect(events).toHaveLength(1);
    return { receipt, event: events[0] as unknown as { eventName: string; args: Record<string, unknown> } };
}

function stored(requestId: Hex) {
    const ev = db.prepare("SELECT * FROM evidence WHERE request_id = ?").all(requestId) as Record<string, unknown>[];
    expect(ev).toHaveLength(1);
    const spend = db.prepare("SELECT * FROM spend_requests WHERE request_id = ?").get(requestId) as Record<string, unknown>;
    const calls = db.prepare("SELECT * FROM kiln_calls WHERE request_id = ?").all(requestId) as Record<string, unknown>[];
    return { evidence: ev[0], pkg: JSON.parse(ev[0].package_json as string) as SpendRequestEvidence, spend, calls };
}

describe("processSpendRequest — rule-blocked requests (F-06 ②, F-07 ①, F-09, F-11 ②)", () => {
    it("F-07 ①: non-allowed merchant → Kiln 0, exactly one tx with SpendBlocked(6), zero tokens, reason in evidence", async () => {
        const { d } = await ready();
        const { kiln, deps } = depsFor(d, []);
        const nonceBefore = await agentNonce(d);
        const vaultBefore = await tokenBalance(d, d.vault);

        const out = await processSpendRequest(deps, { merchantId: "gmarket", amount: 20_000n, itemDescription: "Snacks" });

        expect(out).toMatchObject({ flow: "rule_block", outcome: "blocked", blockReason: 6, pendingFlags: null, kilnCalls: 0, precheckAgreed: true });
        expect(kiln.calls).toHaveLength(0);
        expect((await agentNonce(d)) - nonceBefore).toBe(1);
        expect(await tokenBalance(d, d.vault)).toBe(vaultBefore);

        const { event } = await spendEventOf(out.txHash);
        expect(event.eventName).toBe("SpendBlocked");
        expect(event.args.reason).toBe(6);
        expect(event.args.requestId).toBe(out.requestId);

        const s = stored(out.requestId);
        expect(s.calls).toHaveLength(0);
        expect(s.spend).toMatchObject({ flow: "rule_block", precheck_verdict: "block", precheck_reason: 6, judgment_status: null, tx_hash: out.txHash, outcome: "blocked", onchain_reason: 6 });
        expect(s.pkg.precheck).toMatchObject({ verdict: "block", reason: 6, expected: null });
        expect(s.pkg.judgment).toBeNull();
        expect(s.pkg.submission).toEqual({ agentReviewRequest: true });
        // F-11 ②: the stored record re-hashes to the on-chain evidence hash, and the tx hash is attached.
        expect(hashCanonical(s.evidence.package_json as string)).toBe(event.args.evidenceHash);
        expect(s.evidence.evidence_hash).toBe(out.evidenceHash);
        expect(s.evidence.anchor_tx_hash).toBe(out.txHash);
        expect(s.evidence.anchor_event).toBe("SpendBlocked");
    });

    it("F-09: a <= remaining but a + 1% fee > remaining → Kiln 0, SpendBlocked(7), balances unchanged", async () => {
        const { d } = await ready();
        const { kiln, deps } = depsFor(d, []);
        const remaining = await deps.reader.remainingBudget();
        const vaultBefore = await tokenBalance(d, d.vault);

        const out = await processSpendRequest(deps, { merchantId: "coupang", amount: remaining, itemDescription: "Banner printing" });

        expect(out).toMatchObject({ flow: "rule_block", outcome: "blocked", blockReason: 7, kilnCalls: 0 });
        expect(kiln.calls).toHaveLength(0);
        expect(await tokenBalance(d, d.vault)).toBe(vaultBefore);
        expect(await tokenBalance(d, addr("coupang"))).toBe(0n);
        const { event } = await spendEventOf(out.txHash);
        expect(event.args).toMatchObject({ reason: 7, amount: remaining, fee: remaining / 100n });
        expect(stored(out.requestId).pkg.request).toMatchObject({ amount: remaining.toString(), fee: (remaining / 100n).toString() });
    });

    it("paused vault → SpendBlocked(1) without Kiln", async () => {
        const { d } = await ready();
        await pause(d, `0x${"99".repeat(32)}`);
        const { kiln, deps } = depsFor(d, []);
        const out = await processSpendRequest(deps, { merchantId: "daiso", amount: 5_000n, itemDescription: "Tape" });
        expect(out).toMatchObject({ outcome: "blocked", blockReason: 1, kilnCalls: 0 });
        expect(kiln.calls).toHaveLength(0);
    });

    it("no policy registered → SpendBlocked(2) and the evidence points at the zero policy hash", async () => {
        const d = await deployVault();
        const { deps } = depsFor(d, []);
        const out = await processSpendRequest(deps, { merchantId: "daiso", amount: 1_000n, itemDescription: "Tape" });
        expect(out).toMatchObject({ outcome: "blocked", blockReason: 2, kilnCalls: 0 });
        const { pkg } = stored(out.requestId);
        expect(pkg).toMatchObject({ policyVersion: "0", policyEvidenceHash: ZERO_HASH });
    });
});

describe("processSpendRequest — Kiln intent judgment (F-04 ④, F-07 ②③, F-11 ①)", () => {
    it("F-07 ②: rule-passing request → exactly one Kiln call whose result, usage and Generation-Id are in the evidence; match executes", async () => {
        const { d, policyEvidenceHash } = await ready();
        const { kiln, deps } = depsFor(d, [judge(true)]);
        const merchantBefore = await tokenBalance(d, addr("daiso"));

        const out = await processSpendRequest(deps, {
            merchantId: "daiso",
            amount: 30_000n,
            itemDescription: "Balloons and table decorations for the welcome party",
        });

        expect(out).toMatchObject({ flow: "intent_judge", outcome: "executed", blockReason: null, pendingFlags: null, kilnCalls: 1, precheckAgreed: true });
        expect(kiln.calls).toEqual([
            {
                kind: "intent_judge",
                input: {
                    purpose: DEMO_PURPOSE,
                    delegationText: DEMO_DELEGATION,
                    merchantName: "Daiso",
                    amount: 30_000n,
                    itemDescription: "Balloons and table decorations for the welcome party",
                },
            },
        ]);
        expect((await tokenBalance(d, addr("daiso"))) - merchantBefore).toBe(30_000n);
        expect(await deps.reader.remainingBudget()).toBe(169_700n);

        const s = stored(out.requestId);
        expect(s.calls).toHaveLength(1);
        expect(s.calls[0]).toMatchObject({ flow: "intent_judge", status: "tool_call", prompt_tokens: 410, completion_tokens: 120, reasoning_tokens: 80, generation_id: "gen-judge-true" });
        expect(s.pkg.policyEvidenceHash).toBe(policyEvidenceHash);
        expect(s.pkg.judgment).toMatchObject({
            status: "match",
            reason: "Fits the event.",
            kiln: {
                callId: s.calls[0].call_id,
                provider: "fake",
                generationId: "gen-judge-true",
                usage: { promptTokens: 410, completionTokens: 120, reasoningTokens: 80, totalTokens: 530, costUsd: "0.00012" },
            },
        });
        expect(s.pkg.submission).toEqual({ agentReviewRequest: false });
        expect(s.spend).toMatchObject({ flow: "intent_judge", judgment_status: "match", outcome: "executed", tx_hash: out.txHash });

        // F-11 ①
        const { event } = await spendEventOf(out.txHash);
        expect(event.eventName).toBe("SpendExecuted");
        expect(hashCanonical(s.evidence.package_json as string)).toBe(event.args.evidenceHash);
        expect(s.evidence.anchor_tx_hash).toBe(out.txHash);
    });

    it("F-04 ④ / F-07 ③: Kiln says 'does not fit' → not blocked, pending with flag 2, no token move, one Kiln call; owner approve then pays", async () => {
        const { d } = await ready();
        const { kiln, deps } = depsFor(d, [judge(false)]);
        const vaultBefore = await tokenBalance(d, d.vault);

        const out = await processSpendRequest(deps, { merchantId: "daiso", amount: 15_000n, itemDescription: "Personal gaming mouse" });

        expect(out).toMatchObject({ flow: "intent_judge", outcome: "pending", pendingFlags: 2, blockReason: null, kilnCalls: 1, precheckAgreed: true });
        expect(kiln.calls).toHaveLength(1);
        expect(await tokenBalance(d, d.vault)).toBe(vaultBefore);
        const pending = await deps.reader.getPending(out.requestId);
        expect(pending).toMatchObject({ status: 1, flags: 2, amount: 15_000n, fee: 150n, evidenceHash: out.evidenceHash });

        const s = stored(out.requestId);
        expect(s.pkg.judgment).toMatchObject({ status: "mismatch", reason: "Personal item, not for the event." });
        expect(s.pkg.submission).toEqual({ agentReviewRequest: true });
        expect(s.spend).toMatchObject({ outcome: "pending", pending_flags: 2, judgment_status: "mismatch" });
        const { event } = await spendEventOf(out.txHash);
        expect(hashCanonical(s.evidence.package_json as string)).toBe(event.args.evidenceHash);

        const logs = await ownerCall(d, "approve", out.requestId, `0x${"ab".repeat(32)}`);
        expect(logs.map((l) => l.eventName)).toEqual(["Approved", "SpendExecuted"]);
        expect(await tokenBalance(d, addr("daiso"))).toBe(15_000n);
    });

    it("over-threshold request with a matching purpose → one Kiln call, pending with flag 1 only", async () => {
        const { d } = await ready();
        const { deps } = depsFor(d, [judge(true)]);
        const out = await processSpendRequest(deps, { merchantId: "coupang", amount: 60_000n, itemDescription: "Portable speaker for the event" });
        expect(out).toMatchObject({ outcome: "pending", pendingFlags: 1, kilnCalls: 1, precheckAgreed: true });
        expect(stored(out.requestId).pkg.precheck).toMatchObject({ verdict: "pass", expected: "pending" });
    });

    it.each<[string, FakeReply, string, string]>([
        ["no tool call", { content: "Looks fine to me." }, "invalid_output", "NO_TOOL_CALL"],
        ["invalid arguments", { toolCall: { name: "submit_intent_judgment", arguments: { fits_purpose: "yes" } } }, "invalid_output", "INVALID_ARGS"],
        ["HTTP 402", { httpError: 402 }, "error", "KILN_CREDIT_EXHAUSTED"],
    ])("D-10 fail-closed: %s → pending with flag 2, judgment %s", async (_label, reply, status, reason) => {
        const { d } = await ready();
        const { deps } = depsFor(d, [reply]);
        const out = await processSpendRequest(deps, { merchantId: "daiso", amount: 10_000n, itemDescription: "Balloons" });
        expect(out).toMatchObject({ outcome: "pending", pendingFlags: 2, kilnCalls: 1 });
        const s = stored(out.requestId);
        expect(s.pkg.judgment).toMatchObject({ status, reason });
        expect(s.calls).toHaveLength(1);
        expect(s.spend).toMatchObject({ judgment_status: status });
    });

    it("stale pre-check snapshot: pre-check passes, the contract blocks → outcome from chain, precheckAgreed false", async () => {
        const { d } = await ready();
        const live = createViemVaultReader({ client: publicClient, vault: d.vault, chainId: hardhat.id });
        const before = await live.getState();
        await pause(d, `0x${"98".repeat(32)}`);
        const staleReader: VaultReader = { ...live, getState: async () => before };
        const { kiln, deps } = depsFor(d, [judge(true)], { reader: staleReader });

        const out = await processSpendRequest(deps, { merchantId: "daiso", amount: 5_000n, itemDescription: "Tape" });

        expect(out).toMatchObject({ flow: "intent_judge", outcome: "blocked", blockReason: 1, kilnCalls: 1, precheckAgreed: false });
        expect(kiln.calls).toHaveLength(1);
        expect(stored(out.requestId).spend).toMatchObject({ precheck_verdict: "pass", outcome: "blocked", onchain_reason: 1 });
    });
});

describe("processSpendRequest — rejected inputs and failures", () => {
    it.each<[string, { merchantId: string; amount: bigint; itemDescription: string }]>([
        ["unknown merchant id", { merchantId: "emart", amount: 1_000n, itemDescription: "Tape" }],
        ["amount 0", { merchantId: "daiso", amount: 0n, itemDescription: "Tape" }],
        ["negative amount", { merchantId: "daiso", amount: -5n, itemDescription: "Tape" }],
        ["empty item description", { merchantId: "daiso", amount: 1_000n, itemDescription: "  " }],
        ["201-character item description", { merchantId: "daiso", amount: 1_000n, itemDescription: "x".repeat(201) }],
    ])("%s → VALIDATION_FAILED, nothing sent or stored", async (_label, input) => {
        const { d } = await ready();
        const { kiln, deps } = depsFor(d, [judge(true)]);
        const nonceBefore = await agentNonce(d);
        await expect(processSpendRequest(deps, input)).rejects.toSatisfy((e) => e instanceof AppError && e.code === "VALIDATION_FAILED");
        expect(kiln.calls).toHaveLength(0);
        expect(await agentNonce(d)).toBe(nonceBefore);
        expect(db.prepare("SELECT count(*) FROM spend_requests").pluck().get()).toBe(0);
    });

    it("accepts a 200-character item description (boundary)", async () => {
        const { d } = await ready();
        const { deps } = depsFor(d, [judge(true)]);
        const out = await processSpendRequest(deps, { merchantId: "daiso", amount: 1_000n, itemDescription: "x".repeat(200) });
        expect(out.outcome).toBe("executed");
    });

    it("a reverted spend (duplicate requestId) marks the request failed and throws CHAIN_TX_REVERTED", async () => {
        const { d } = await ready();
        const fixedId = `0x${"5a".repeat(32)}` as Hex;
        const { deps } = depsFor(d, [judge(true), judge(true)], { newRequestId: () => fixedId });
        await processSpendRequest(deps, { merchantId: "daiso", amount: 1_000n, itemDescription: "Tape" });
        // A second, empty database so the reused id reaches the chain instead of failing the local primary key.
        const db2 = openDatabase(":memory:");
        const deps2 = { ...deps, evidence: createEvidenceRepo(db2), kilnCalls: createKilnCallRepo(db2), spendRequests: createSpendRequestRepo(db2), chainEvents: createChainEventRepo(db2) };
        await registerPolicyEvidenceCopy(db, db2);
        await expect(processSpendRequest(deps2, { merchantId: "daiso", amount: 1_000n, itemDescription: "Tape again" })).rejects.toSatisfy(
            (e) => e instanceof AppError && e.code === "CHAIN_TX_REVERTED",
        );
        expect(db2.prepare("SELECT outcome FROM spend_requests WHERE request_id = ?").pluck().get(fixedId)).toBe("failed");
        db2.close();
    });

    it("refuses to ask Kiln when the active policy's evidence is not stored locally (no purpose to judge against)", async () => {
        const { d } = await ready();
        const empty = openDatabase(":memory:");
        const { kiln, deps } = depsFor(d, [judge(true)], {
            evidence: createEvidenceRepo(empty),
            kilnCalls: createKilnCallRepo(empty),
            spendRequests: createSpendRequestRepo(empty),
            chainEvents: createChainEventRepo(empty),
        });
        const nonceBefore = await agentNonce(d);
        await expect(processSpendRequest(deps, { merchantId: "daiso", amount: 1_000n, itemDescription: "Tape" })).rejects.toSatisfy(
            (e) => e instanceof AppError && e.code === "POLICY_EVIDENCE_NOT_FOUND",
        );
        expect(kiln.calls).toHaveLength(0);
        expect(await agentNonce(d)).toBe(nonceBefore);
        empty.close();
    });
});

describe("processSpendRequest — active policy from the event cache (ADR-0004, D-35)", () => {
    it("scans deployBlock..latest once, then only blocks after the cached cursor; the PolicySet is cached", async () => {
        const { d, policyEvidenceHash } = await ready();
        const live = createViemVaultReader({ client: publicClient, vault: d.vault, chainId: hardhat.id });
        const ranges: { from: bigint; to: bigint }[] = [];
        const reader: VaultReader = {
            ...live,
            getLogs: (from, to) => {
                ranges.push({ from, to });
                return live.getLogs(from, to);
            },
        };
        const { deps } = depsFor(d, [judge(true), judge(true)], { reader });

        const first = await processSpendRequest(deps, { merchantId: "daiso", amount: 1_000n, itemDescription: "Tape" });
        const second = await processSpendRequest(deps, { merchantId: "daiso", amount: 1_000n, itemDescription: "Glue" });

        expect([first.outcome, second.outcome]).toEqual(["executed", "executed"]);
        expect(ranges).toHaveLength(2);
        expect(ranges[0].from).toBe(d.deployBlock);
        expect(ranges[1].from).toBe(ranges[0].to + 1n);
        const cached = db.prepare("SELECT event_name, evidence_hash FROM chain_events WHERE event_name = ?").all("PolicySet");
        expect(cached).toEqual([{ event_name: "PolicySet", evidence_hash: policyEvidenceHash }]);
        expect(stored(second.requestId).pkg.policyEvidenceHash).toBe(policyEvidenceHash);
    });

    it("no PolicySet for the active version in the cache → POLICY_EVENT_NOT_FOUND before any Kiln call or tx", async () => {
        const { d } = await ready();
        const live = createViemVaultReader({ client: publicClient, vault: d.vault, chainId: hardhat.id });
        const { kiln, deps } = depsFor(d, [judge(true)], { reader: { ...live, getLogs: async () => [] } });
        const nonceBefore = await agentNonce(d);
        await expect(processSpendRequest(deps, { merchantId: "daiso", amount: 1_000n, itemDescription: "Tape" })).rejects.toSatisfy(
            (e) => e instanceof AppError && e.code === "POLICY_EVENT_NOT_FOUND",
        );
        expect(kiln.calls).toHaveLength(0);
        expect(await agentNonce(d)).toBe(nonceBefore);
    });
});

/** Copies policy_set evidence rows so a second, empty database can resolve the active policy. */
async function registerPolicyEvidenceCopy(from: Database.Database, to: Database.Database) {
    const rows = from.prepare("SELECT * FROM evidence WHERE kind = 'policy_set'").all() as Record<string, unknown>[];
    const repo = createEvidenceRepo(to);
    for (const r of rows)
        repo.insert({
            evidenceId: r.evidence_id as string,
            kind: "policy_set",
            chainId: r.chain_id as number,
            vault: r.vault as Hex,
            requestId: null,
            packageJson: r.package_json as string,
            evidenceHash: r.evidence_hash as Hex,
            createdAt: r.created_at as string,
        });
}
