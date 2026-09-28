import type Database from "better-sqlite3";
import { getAddress, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEvidenceRepo } from "@/adapters/db/evidenceRepo";
import { createKilnCallRepo } from "@/adapters/db/kilnCallRepo";
import { openDatabase } from "@/adapters/db/sqlite";
import { FakeKilnClient, defaultFakeHandler } from "@/adapters/kiln/fakeKilnClient";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import { hashCanonical, type PolicySetEvidence } from "@/core/domain/evidence";
import type { PolicyValues } from "@/core/domain/types";
import { AppError } from "@/core/errors";
import { parsePolicy } from "@/core/usecases/parsePolicy";
import { prepareOwnerAction, type PrepareOwnerActionDeps } from "@/core/usecases/prepareOwnerAction";

// prepareOwnerAction (Architecture 8, 데이터 흐름 A-4 / C): builds and stores the owner's evidence package
// before any tx and returns the contract call. Used by the E2E owner steps (and later by the API route).

const CHAIN_ID = 31337;
const VAULT = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
const OWNER = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const NOW = new Date("2026-09-28T03:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DELEGATION = "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐";

let db: Database.Database;
let deps: PrepareOwnerActionDeps;
beforeEach(() => {
    db = openDatabase(":memory:");
    let n = 0;
    deps = {
        chainId: CHAIN_ID,
        vault: VAULT,
        vaultOwner: OWNER,
        feeBps: 100,
        evidence: createEvidenceRepo(db),
        kilnCalls: createKilnCallRepo(db),
        merchants: MERCHANT_REGISTRY,
        clock: { now: () => NOW },
        newId: () => `ev-${++n}`,
    };
});
afterEach(() => db.close());

const final: PolicyValues = {
    budget: 200_000n,
    approvalThreshold: 50_000n,
    expiresAt: NOW_S + 7 * 86_400,
    maxPerMinute: 3,
    maxPerDay: 20,
    merchantIds: ["coupang", "daiso"],
    purpose: "Supplies for the student club welcome party",
};

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;
const count = () => db.prepare("SELECT count(*) FROM evidence").pluck().get();

async function parsed() {
    const r = await parsePolicy(
        { kiln: new FakeKilnClient(defaultFakeHandler), kilnCalls: deps.kilnCalls, merchants: MERCHANT_REGISTRY, clock: deps.clock, chainId: CHAIN_ID, vault: VAULT },
        { delegationText: DELEGATION },
    );
    if (!r.ok) throw new Error("fake parse failed");
    return r;
}

describe("prepareOwnerAction — policy_set (F-02 evidence)", () => {
    it("stores AI candidate vs owner final, the Kiln ref, and returns setPolicy args with the evidence hash", async () => {
        const p = await parsed();
        const out = await prepareOwnerAction(deps, {
            kind: "policy_set",
            owner: OWNER.toLowerCase() as Hex,
            parseCallId: p.parseCallId,
            delegationText: DELEGATION,
            final,
            expiresAtSource: "owner",
            ownerEdits: ["expiresAt", "purpose"],
        });

        const row = deps.evidence.findById(out.evidenceId)!;
        expect(row).toMatchObject({ kind: "policy_set", chainId: CHAIN_ID, vault: VAULT, requestId: null, evidenceHash: out.evidenceHash, anchor: null });
        expect(hashCanonical(row.packageJson)).toBe(out.evidenceHash);
        const pkg = JSON.parse(row.packageJson) as PolicySetEvidence;
        expect(pkg).toMatchObject({
            schema: "agent-spend-evidence/v1",
            chainId: CHAIN_ID,
            vault: VAULT,
            createdAt: NOW.toISOString(),
            kind: "policy_set",
            owner: OWNER,
            delegationText: DELEGATION,
            ownerEdits: ["expiresAt", "purpose"],
            feeBps: 100,
            final: {
                budget: "200000",
                approvalThreshold: "50000",
                expiresAt: final.expiresAt,
                expiresAtSource: "owner",
                maxPerMinute: 3,
                maxPerDay: 20,
                purpose: final.purpose,
                merchants: [
                    { id: "coupang", displayName: "Coupang", address: getAddress("0x000000000000000000000000000000000000c0a9") },
                    { id: "daiso", displayName: "Daiso", address: getAddress("0x000000000000000000000000000000000000da15") },
                ],
            },
        });
        expect(pkg.kiln).toMatchObject({ callId: p.parseCallId, provider: "fake", model: "qwen3-32b" });
        expect(pkg.candidate).toEqual(JSON.parse(pkg.kiln!.rawArguments!));
        expect(pkg.candidate).toMatchObject({ total_budget_krw: 200_000, approval_threshold_krw: 50_000 });

        expect(out.call).toEqual({
            functionName: "setPolicy",
            args: [
                {
                    budget: 200_000n,
                    approvalThreshold: 50_000n,
                    expiresAt: BigInt(final.expiresAt),
                    maxPerMinute: 3,
                    maxPerDay: 20,
                    merchants: [getAddress("0x000000000000000000000000000000000000c0a9"), getAddress("0x000000000000000000000000000000000000da15")],
                },
                out.evidenceHash,
            ],
        });
    });

    it("without a Kiln parse (owner typed the policy) → kiln and candidate are null", async () => {
        const out = await prepareOwnerAction(deps, {
            kind: "policy_set",
            owner: OWNER,
            parseCallId: null,
            delegationText: DELEGATION,
            final,
            expiresAtSource: "owner",
            ownerEdits: [],
        });
        const pkg = JSON.parse(deps.evidence.findById(out.evidenceId)!.packageJson) as PolicySetEvidence;
        expect(pkg.kiln).toBeNull();
        expect(pkg.candidate).toBeNull();
    });

    it.each<[string, () => Parameters<typeof prepareOwnerAction>[1], string]>([
        ["a different owner address", () => ({ kind: "policy_set", owner: VAULT, parseCallId: null, delegationText: DELEGATION, final, expiresAtSource: "owner", ownerEdits: [] }), "NOT_OWNER"],
        ["an unknown parse call id", () => ({ kind: "policy_set", owner: OWNER, parseCallId: "missing", delegationText: DELEGATION, final, expiresAtSource: "owner", ownerEdits: [] }), "NOT_FOUND"],
        ["a missing expiry", () => ({ kind: "policy_set", owner: OWNER, parseCallId: null, delegationText: DELEGATION, final: { ...final, expiresAt: 0 }, expiresAtSource: "owner", ownerEdits: [] }), "EXPIRY_REQUIRED"],
        ["an expiry in the past", () => ({ kind: "policy_set", owner: OWNER, parseCallId: null, delegationText: DELEGATION, final: { ...final, expiresAt: NOW_S - 1 }, expiresAtSource: "owner", ownerEdits: [] }), "SCHEMA_INVALID"],
        ["a merchant outside the registry", () => ({ kind: "policy_set", owner: OWNER, parseCallId: null, delegationText: DELEGATION, final: { ...final, merchantIds: ["emart"] }, expiresAtSource: "owner", ownerEdits: [] }), "UNKNOWN_MERCHANT"],
        ["an empty delegation text", () => ({ kind: "policy_set", owner: OWNER, parseCallId: null, delegationText: " ", final, expiresAtSource: "owner", ownerEdits: [] }), "VALIDATION_FAILED"],
    ])("rejects %s and stores nothing", async (_label, input, c) => {
        await expect(prepareOwnerAction(deps, input())).rejects.toSatisfy(code(c));
        expect(count()).toBe(0);
    });
});

describe("prepareOwnerAction — approval / rejection / pause / unpause", () => {
    function storeSpendRequest(requestId: Hex, hash: Hex) {
        deps.evidence.insert({ evidenceId: `sr-${requestId.slice(2, 6)}`, kind: "spend_request", chainId: CHAIN_ID, vault: VAULT, requestId, packageJson: "{}", evidenceHash: hash, createdAt: NOW.toISOString() });
    }
    const rid = `0x${"12".repeat(32)}` as Hex;
    const reqHash = `0x${"34".repeat(32)}` as Hex;

    it.each(["approval", "rejection"] as const)("%s links the request's evidence hash and returns the matching call", async (kind) => {
        storeSpendRequest(rid, reqHash);
        const out = await prepareOwnerAction(deps, { kind, owner: OWNER, requestId: rid });
        const row = deps.evidence.findById(out.evidenceId)!;
        expect(row).toMatchObject({ kind, requestId: rid });
        expect(JSON.parse(row.packageJson)).toEqual({
            schema: "agent-spend-evidence/v1",
            chainId: CHAIN_ID,
            vault: VAULT,
            createdAt: NOW.toISOString(),
            kind,
            requestId: rid,
            requestEvidenceHash: reqHash,
            owner: OWNER,
        });
        expect(out.call).toEqual({ functionName: kind === "approval" ? "approve" : "reject", args: [rid, out.evidenceHash] });
    });

    it("approval of a request with no stored spend evidence → NOT_FOUND", async () => {
        await expect(prepareOwnerAction(deps, { kind: "approval", owner: OWNER, requestId: rid })).rejects.toSatisfy(code("NOT_FOUND"));
        expect(count()).toBe(0);
    });

    it.each([
        ["pause", "", "pause"],
        ["unpause", "n".repeat(200), "unpause"],
    ] as const)("%s with a %s-length note (0 and 200 are the bounds)", async (kind, note, fn) => {
        const out = await prepareOwnerAction(deps, { kind, owner: OWNER, note });
        expect(JSON.parse(deps.evidence.findById(out.evidenceId)!.packageJson)).toMatchObject({ kind, owner: OWNER, note });
        expect(out.call).toEqual({ functionName: fn, args: [out.evidenceHash] });
    });

    it("a 201-character note → VALIDATION_FAILED", async () => {
        await expect(prepareOwnerAction(deps, { kind: "pause", owner: OWNER, note: "n".repeat(201) })).rejects.toSatisfy(code("VALIDATION_FAILED"));
        expect(count()).toBe(0);
    });
});
