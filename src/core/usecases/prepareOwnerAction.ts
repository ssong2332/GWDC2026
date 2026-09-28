import { getAddress } from "viem";
import { EVIDENCE_SCHEMA, INPUT_LIMITS, OWNER_NOTE_MAX } from "@/config/constants";
import { hashPackage, type EvidencePackage, type KilnRef, type PolicySetEvidence } from "@/core/domain/evidence";
import { validateFinalPolicy } from "@/core/domain/policy";
import type { Hex, MerchantEntry, PolicyValues } from "@/core/domain/types";
import { AppError } from "@/core/errors";
import type { Clock, EvidenceRepo, KilnCallRepo } from "@/core/ports";

export type PrepareOwnerActionDeps = {
    chainId: number;
    vault: Hex;
    /** PolicyVault.owner (from the deployment file). A UI guard only — the contract's onlyOwner is the authority. */
    vaultOwner: Hex;
    feeBps: number;
    evidence: EvidenceRepo;
    kilnCalls: KilnCallRepo;
    merchants: MerchantEntry[];
    clock: Clock;
    newId?: () => string;
};

export type PrepareOwnerActionInput =
    | {
          kind: "policy_set";
          owner: Hex;
          parseCallId: string | null;
          delegationText: string;
          final: PolicyValues;
          expiresAtSource: "kiln" | "owner";
          ownerEdits: string[];
      }
    | { kind: "approval" | "rejection"; owner: Hex; requestId: Hex }
    | { kind: "pause" | "unpause"; owner: Hex; note: string };

export type OwnerCall = {
    functionName: "setPolicy" | "approve" | "reject" | "pause" | "unpause";
    args: unknown[];
};

const CALL_FOR = { approval: "approve", rejection: "reject", pause: "pause", unpause: "unpause" } as const;

function kilnRefFor(deps: PrepareOwnerActionDeps, parseCallId: string | null): { kiln: KilnRef | null; candidate: unknown } {
    if (parseCallId === null) return { kiln: null, candidate: null };
    const r = deps.kilnCalls.findById(parseCallId);
    if (!r || r.flow !== "policy_parse") throw new AppError("NOT_FOUND", `no policy_parse Kiln call ${parseCallId}`);
    let candidate: unknown = null;
    if (r.rawArguments !== null) {
        try {
            candidate = JSON.parse(r.rawArguments);
        } catch {
            candidate = null; // invalid JSON never became a candidate (F-01 ②); rawArguments keeps the original text
        }
    }
    const kiln: KilnRef = {
        callId: r.callId,
        provider: r.provider,
        model: r.model,
        generationId: r.generationId,
        finishReason: r.finishReason,
        usage: {
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            reasoningTokens: r.reasoningTokens,
            totalTokens: r.totalTokens,
            costUsd: r.costUsd,
        },
        rawArguments: r.rawArguments,
    };
    return { kiln, candidate };
}

/**
 * F-02 / F-04 ② / F-05: builds the owner's evidence package, stores it (before any tx) and returns the
 * PolicyVault call whose last argument is the evidence hash. Signing happens elsewhere (browser wallet or CLI).
 */
export async function prepareOwnerAction(
    deps: PrepareOwnerActionDeps,
    i: PrepareOwnerActionInput,
): Promise<{ evidenceId: string; evidenceHash: Hex; call: OwnerCall }> {
    if (getAddress(i.owner) !== getAddress(deps.vaultOwner))
        throw new AppError("NOT_OWNER", "the connected address is not the vault owner");
    const owner = getAddress(i.owner);
    const createdAt = deps.clock.now().toISOString();
    const base = { schema: EVIDENCE_SCHEMA, chainId: deps.chainId, vault: getAddress(deps.vault), createdAt } as const;

    let pkg: EvidencePackage;
    let requestId: Hex | null = null;
    let call: (hash: Hex) => OwnerCall;

    if (i.kind === "policy_set") {
        const text = i.delegationText;
        if (text.trim().length === 0 || text.length > INPUT_LIMITS.delegationTextMax)
            throw new AppError("VALIDATION_FAILED", `delegationText must be 1..${INPUT_LIMITS.delegationTextMax} characters`);
        const nowSec = Math.floor(deps.clock.now().getTime() / 1000);
        const v = validateFinalPolicy(i.final, deps.merchants, nowSec);
        if (!v.ok) throw new AppError(v.code, v.message);
        const { kiln, candidate } = kilnRefFor(deps, i.parseCallId);
        const merchants = i.final.merchantIds.map((id) => {
            const m = deps.merchants.find((x) => x.id === id)!;
            return { id: m.id, displayName: m.displayName, address: getAddress(m.address) };
        });
        const f = i.final;
        const policy: PolicySetEvidence = {
            ...base,
            kind: "policy_set",
            owner,
            delegationText: text,
            kiln,
            candidate,
            final: {
                budget: f.budget.toString(),
                approvalThreshold: f.approvalThreshold.toString(),
                expiresAt: f.expiresAt,
                expiresAtSource: i.expiresAtSource,
                maxPerMinute: f.maxPerMinute,
                maxPerDay: f.maxPerDay,
                purpose: f.purpose,
                merchants,
            },
            ownerEdits: i.ownerEdits,
            feeBps: deps.feeBps,
        };
        pkg = policy;
        call = (hash) => ({
            functionName: "setPolicy",
            args: [
                {
                    budget: f.budget,
                    approvalThreshold: f.approvalThreshold,
                    expiresAt: BigInt(f.expiresAt),
                    maxPerMinute: f.maxPerMinute,
                    maxPerDay: f.maxPerDay,
                    merchants: merchants.map((m) => m.address),
                },
                hash,
            ],
        });
    } else if ("requestId" in i) {
        const request = deps.evidence.listByRequestId(i.requestId).find((r) => r.kind === "spend_request");
        if (!request) throw new AppError("NOT_FOUND", `no spend request evidence for ${i.requestId}`);
        requestId = i.requestId;
        pkg = { ...base, kind: i.kind, requestId: i.requestId, requestEvidenceHash: request.evidenceHash, owner };
        const functionName = CALL_FOR[i.kind];
        call = (hash) => ({ functionName, args: [i.requestId, hash] });
    } else {
        if (i.note.length > OWNER_NOTE_MAX) throw new AppError("VALIDATION_FAILED", `note must be 0..${OWNER_NOTE_MAX} characters`);
        pkg = { ...base, kind: i.kind, owner, note: i.note };
        const functionName = CALL_FOR[i.kind];
        call = (hash) => ({ functionName, args: [hash] });
    }

    const { canonical, hash } = hashPackage(pkg);
    const evidenceId = (deps.newId ?? (() => crypto.randomUUID()))();
    deps.evidence.insert({ evidenceId, kind: pkg.kind, chainId: deps.chainId, vault: getAddress(deps.vault), requestId, packageJson: canonical, evidenceHash: hash, createdAt });
    return { evidenceId, evidenceHash: hash, call: call(hash) };
}
