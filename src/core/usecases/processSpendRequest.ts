import { bytesToHex, getAddress } from "viem";
import { EVIDENCE_SCHEMA, INPUT_LIMITS, ZERO_HASH } from "@/config/constants";
import { hashPackage, type PolicySetEvidence, type SpendRequestEvidence } from "@/core/domain/evidence";
import { interpretIntentOutcome } from "@/core/domain/intent";
import { evaluatePrecheck, remainingBudget } from "@/core/domain/precheck";
import type { BlockReason } from "@/core/domain/reasons";
import type { Hex, MerchantEntry, SpendOutcome, SpendRequestInput, VaultStateSnapshot } from "@/core/domain/types";
import { AppError } from "@/core/errors";
import type {
    AgentVaultWriter,
    ChainEventRepo,
    Clock,
    DecodedVaultEvent,
    EvidenceRepo,
    KilnCallRepo,
    KilnClient,
    SpendRequestRepo,
    VaultReader,
} from "@/core/ports";
import { saveKilnCall, toKilnRef } from "./kilnRecords";
import { pullNewEvents, toAnchor } from "./syncChainEvents";

export type ProcessSpendDeps = {
    chainId: number;
    vault: Hex;
    /** First block of the event cache when it is empty (ADR-0004). */
    deployBlock: bigint;
    reader: VaultReader;
    writer: AgentVaultWriter;
    kiln: KilnClient;
    evidence: EvidenceRepo;
    kilnCalls: KilnCallRepo;
    spendRequests: SpendRequestRepo;
    chainEvents: ChainEventRepo;
    merchants: MerchantEntry[];
    clock: Clock;
    newRequestId?: () => Hex;
    newId?: () => string;
};

const SPEND_EVENTS = { SpendExecuted: "executed", SpendBlocked: "blocked", SpendPending: "pending" } as const;
type SpendEventName = keyof typeof SPEND_EVENTS;

function randomRequestId(): Hex {
    return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

function validate(deps: ProcessSpendDeps, i: SpendRequestInput): MerchantEntry {
    const merchant = deps.merchants.find((m) => m.id === i.merchantId);
    if (!merchant) throw new AppError("VALIDATION_FAILED", `unknown merchant id: ${i.merchantId}`);
    if (i.amount <= 0n) throw new AppError("VALIDATION_FAILED", "amount must be a positive integer (KRW)");
    const desc = i.itemDescription;
    if (desc.trim().length === 0 || desc.length > INPUT_LIMITS.itemDescriptionMax)
        throw new AppError("VALIDATION_FAILED", `itemDescription must be 1..${INPUT_LIMITS.itemDescriptionMax} characters`);
    return merchant;
}

/**
 * The active policy's evidence hash (from its PolicySet event) and, if stored locally, its package.
 * The event comes from the incremental cache (ADR-0004): only blocks after the cached cursor are fetched.
 */
async function activePolicy(
    deps: ProcessSpendDeps,
    state: VaultStateSnapshot,
): Promise<{ hash: Hex; pkg: PolicySetEvidence | null }> {
    if (state.policyVersion === 0n) return { hash: ZERO_HASH, pkg: null };
    await pullNewEvents(deps);
    const set = deps.chainEvents
        .list(deps.chainId, deps.vault)
        .filter((e) => e.name === "PolicySet" && e.args.policyVersion === state.policyVersion).at(-1);
    if (!set)
        throw new AppError("POLICY_EVENT_NOT_FOUND", `no PolicySet event for policy version ${state.policyVersion} in the event cache`);
    const hash = set.args.evidenceHash as Hex;
    const row = deps.evidence.findByHash(hash);
    const pkg = row && row.kind === "policy_set" ? (JSON.parse(row.packageJson) as PolicySetEvidence) : null;
    return { hash, pkg };
}

/**
 * Agent spend pipeline (Architecture 데이터 흐름 B, F-03/F-04 ④/F-06/F-07/F-09/F-11):
 * read state → deterministic pre-check → (pass only) one Kiln intent judgment → evidence saved before the tx
 * → PolicyVault.spend with the evidence hash → outcome and anchor from the mined receipt.
 * Pre-check blocks are still submitted on-chain (ADR-0002) with agentReviewRequest=true (D-12).
 */
export async function processSpendRequest(deps: ProcessSpendDeps, i: SpendRequestInput): Promise<SpendOutcome> {
    const merchant = validate(deps, i);
    const merchantAddress = getAddress(merchant.address);
    const requestId = (deps.newRequestId ?? randomRequestId)();
    const ctx = { chainId: deps.chainId, vault: deps.vault };

    const state = await deps.reader.getState();
    const pre = evaluatePrecheck(state, { merchant: merchantAddress, amount: i.amount });
    const policy = await activePolicy(deps, state);

    let judgment: SpendRequestEvidence["judgment"] = null;
    let agentReviewRequest = true;
    if (pre.verdict === "pass") {
        if (!policy.pkg)
            throw new AppError("POLICY_EVIDENCE_NOT_FOUND", `evidence ${policy.hash} for the active policy is not stored locally`);
        const result = await deps.kiln.judgeIntent({
            purpose: policy.pkg.final.purpose,
            delegationText: policy.pkg.delegationText,
            merchantName: merchant.displayName,
            amount: i.amount,
            itemDescription: i.itemDescription,
        });
        saveKilnCall(deps.kilnCalls, result, { ...ctx, requestId });
        const j = interpretIntentOutcome(result.outcome, result.record.callId);
        judgment = { status: j.status, reason: j.reason, kiln: toKilnRef(result) };
        agentReviewRequest = j.status !== "match";
    }
    const flow = pre.verdict === "block" ? "rule_block" : "intent_judge";

    const createdAt = deps.clock.now().toISOString();
    const pkg: SpendRequestEvidence = {
        schema: EVIDENCE_SCHEMA,
        chainId: deps.chainId,
        vault: getAddress(deps.vault),
        createdAt,
        kind: "spend_request",
        requestId,
        policyVersion: state.policyVersion.toString(),
        policyEvidenceHash: policy.hash,
        request: {
            merchantId: merchant.id,
            merchantAddress,
            amount: i.amount.toString(),
            fee: pre.fee.toString(),
            itemDescription: i.itemDescription,
        },
        precheck: {
            verdict: pre.verdict,
            reason: pre.verdict === "block" ? pre.reason : null,
            expected: pre.verdict === "pass" ? pre.expected : null,
            snapshot: {
                blockNumber: state.blockNumber.toString(),
                blockTimestamp: state.blockTimestamp,
                remaining: remainingBudget(state).toString(),
                paused: state.paused,
                minuteCount: state.minuteCount,
                dayCount: state.dayCount,
            },
        },
        judgment,
        submission: { agentReviewRequest },
    };
    const { canonical, hash: evidenceHash } = hashPackage(pkg);
    const evidenceId = (deps.newId ?? (() => crypto.randomUUID()))();
    deps.evidence.insert({ evidenceId, kind: "spend_request", ...ctx, requestId, packageJson: canonical, evidenceHash, createdAt });
    deps.spendRequests.insert({
        requestId,
        evidenceId,
        ...ctx,
        flow,
        merchantId: merchant.id,
        amount: i.amount,
        fee: pre.fee,
        precheckVerdict: pre.verdict,
        precheckReason: pre.verdict === "block" ? pre.reason : null,
        judgmentStatus: judgment?.status ?? null,
        txHash: null,
        outcome: null,
        onchainReason: null,
        pendingFlags: null,
        createdAt,
    });

    let sent: Awaited<ReturnType<AgentVaultWriter["spend"]>>;
    try {
        sent = await deps.writer.spend({ requestId, merchant: merchantAddress, amount: i.amount, agentReviewRequest, evidenceHash });
    } catch (err) {
        deps.spendRequests.updateOutcome(requestId, { outcome: "failed" });
        throw err;
    }
    const { txHash, receipt } = sent;
    const event = receipt.events.find(
        (e): e is DecodedVaultEvent & { name: SpendEventName } =>
            e.name in SPEND_EVENTS && String(e.args.requestId).toLowerCase() === requestId.toLowerCase(),
    );
    if (receipt.status !== "success" || !event) {
        deps.spendRequests.updateOutcome(requestId, { txHash, outcome: "failed" });
        throw new AppError("CHAIN_TX_REVERTED", `spend tx ${txHash} did not emit a spend event`);
    }

    const outcome = SPEND_EVENTS[event.name];
    const blockReason = outcome === "blocked" ? (Number(event.args.reason) as BlockReason) : null;
    const pendingFlags = outcome === "pending" ? Number(event.args.flags) : null;
    deps.evidence.setAnchor(evidenceHash, toAnchor(event));
    deps.spendRequests.updateOutcome(requestId, { txHash, outcome, onchainReason: blockReason, pendingFlags });

    const predicted =
        pre.verdict === "block" ? "blocked" : pre.expected === "pending" || agentReviewRequest ? "pending" : "executed";
    const precheckAgreed =
        predicted === outcome && (pre.verdict !== "block" || pre.reason === blockReason);

    return {
        requestId,
        flow,
        txHash,
        outcome,
        blockReason,
        pendingFlags,
        evidenceHash,
        kilnCalls: pre.verdict === "pass" ? 1 : 0,
        precheckAgreed,
    };
}
