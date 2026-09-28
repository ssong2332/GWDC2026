import { getAddress, type Hex } from "viem";
import { hardhat } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKilnClient, queueHandler, type FakeReply } from "@/adapters/kiln/fakeKilnClient";
import { parseServerEnv } from "@/config/env";
import { kstDate } from "@/core/domain/policy";
import { postJson, requestJson } from "@/ui/apiClient";
import { apiFetch, deploymentOf } from "./helpers/api";
import { deployVault, freshMinute, latestTimestamp, type Deployed } from "./helpers/chain";
import { INTEGRATION_RPC_URL } from "./helpers/rpc";

// Route Handlers (Architecture 9 HTTP API) against a real Hardhat node + SQLite + fake Kiln, through the browser
// JSON client. `server-only` resolves to an empty module under Next; Vitest has no react-server condition.
vi.mock("server-only", () => ({}));
const { createAppContainer } = await import("@/server/container");
type AppContainer = import("@/server/container").AppContainer;

const DEMO = "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐";
const env = parseServerEnv({ RPC_URL: INTEGRATION_RPC_URL, DATABASE_PATH: ":memory:", KILN_MODE: "fake" });

let d: Deployed;
let c: AppContainer;
let api: typeof fetch;
beforeEach(async () => {
    await freshMinute();
    d = await deployVault();
    c = createAppContainer(env, { deployment: deploymentOf(d) });
    api = apiFetch(c);
});
afterEach(() => c.close());

const parse = (text: unknown) => postJson<Record<string, unknown>>("/api/policy/parse", { delegationText: text }, api);

describe("POST /api/policy/parse (F-01)", () => {
    it("demo sentence → validated candidate (bigints as strings), no expiry, usage; the Kiln call is stored", async () => {
        const r = await parse(DEMO);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.data.candidate).toEqual({
            budget: "200000",
            approvalThreshold: "50000",
            merchantIds: ["daiso", "coupang"],
            expiresOn: null,
            purpose: expect.any(String),
            unrecognizedMerchants: [],
        });
        expect(r.data.warnings).toEqual([]);
        expect(r.data.usage).toEqual({ promptTokens: 0, completionTokens: 0, reasoningTokens: null, totalTokens: 0, costUsd: null, generationId: null, provider: "fake" });
        const row = c.kilnCalls.findById(r.data.parseCallId as string);
        expect(row).toMatchObject({ flow: "policy_parse", provider: "fake" });
    });

    it("sentence with an expiry date → expiresOn filled (F-01 ④)", async () => {
        const r = await parse(`${DEMO}, 2026-10-05까지`);
        expect(r.ok && (r.data.candidate as { expiresOn: string }).expiresOn).toBe("2026-10-05");
    });

    it("schema violation (no amount) → 422 SCHEMA_INVALID, no candidate (F-01 ②)", async () => {
        const r = await parse("Buy snacks at Daiso");
        expect(r).toMatchObject({ ok: false, status: 422, error: { code: "SCHEMA_INVALID" } });
    });

    it.each([
        ["empty text", ""],
        ["whitespace only", "   "],
        ["over 500 characters", "가".repeat(501)],
        ["not a string", 42],
    ])("%s → 400 VALIDATION_FAILED", async (_n, text) => {
        expect(await parse(text)).toMatchObject({ ok: false, status: 400, error: { code: "VALIDATION_FAILED" } });
    });

    it("malformed JSON body → 400 VALIDATION_FAILED", async () => {
        const r = await requestJson("/api/policy/parse", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } }, api);
        expect(r).toMatchObject({ ok: false, status: 400, error: { code: "VALIDATION_FAILED" } });
    });

    it.each([
        [{ httpError: 402 }, 402, "KILN_CREDIT_EXHAUSTED"],
        [{ httpError: 429 }, 429, "KILN_RATE_LIMITED"],
        [{ httpError: 503 }, 502, "KILN_UNAVAILABLE"],
        [{ content: "I cannot help" }, 422, "NO_TOOL_CALL"],
    ] as [FakeReply, number, string][])("Kiln failure %j → %i %s, policy not produced", async (reply, status, code) => {
        c.close();
        c = createAppContainer(env, { deployment: deploymentOf(d), kiln: new FakeKilnClient(queueHandler([reply])) });
        api = apiFetch(c);
        expect(await parse(DEMO)).toMatchObject({ ok: false, status, error: { code } });
    });
});

describe("GET /api/vault/state, /api/vault/activity, /api/receipts/[id] — before any policy", () => {
    it("state: chain, addresses, fee, no explorer on localhost, policyVersion 0", async () => {
        const r = await requestJson<Record<string, unknown>>("/api/vault/state", undefined, api);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.data).toMatchObject({
            chainId: hardhat.id,
            vault: getAddress(d.vault),
            token: getAddress(d.token),
            owner: getAddress(d.owner),
            agent: getAddress(d.agent),
            feeBps: 100,
            explorerTxUrl: null,
        });
        expect(r.data.state).toMatchObject({ policyVersion: "0", budget: "0", spent: "0", reserved: "0", paused: false, vaultBalance: "1000000", pendingCount: 0 });
    });

    it("activity: empty list (빈 값)", async () => {
        expect(await requestJson("/api/vault/activity", undefined, api)).toEqual({ ok: true, data: { items: [] } });
    });

    it("receipt: unknown request → 404 NOT_FOUND, malformed id → 400", async () => {
        expect(await requestJson(`/api/receipts/0x${"ab".repeat(32)}`, undefined, api)).toMatchObject({ ok: false, status: 404, error: { code: "NOT_FOUND" } });
        expect(await requestJson("/api/receipts/0x12", undefined, api)).toMatchObject({ ok: false, status: 400, error: { code: "VALIDATION_FAILED" } });
    });

    it("RPC unreachable → 502 CHAIN_RPC_ERROR without the RPC URL in the response", async () => {
        c.close();
        c = createAppContainer(parseServerEnv({ RPC_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:" }), { deployment: deploymentOf(d) });
        const r = await requestJson("/api/vault/state", undefined, apiFetch(c));
        expect(r).toMatchObject({ ok: false, status: 502, error: { code: "CHAIN_RPC_ERROR" } });
        expect(JSON.stringify(r)).not.toContain("127.0.0.1:1");
    });
});

describe("POST /api/owner-actions/prepare and /confirm — guards", () => {
    async function policyBody(owner: Hex, over: Record<string, unknown> = {}) {
        const p = await parse(DEMO);
        if (!p.ok) throw new Error("parse failed");
        const expiresOn = kstDate(new Date(((await latestTimestamp()) + 30 * 86_400) * 1000));
        const { expiresOnToUnix } = await import("@/core/domain/policy");
        return {
            kind: "policy_set",
            owner,
            parseCallId: p.data.parseCallId,
            delegationText: DEMO,
            final: {
                budget: "200000",
                approvalThreshold: "50000",
                expiresAt: expiresOnToUnix(expiresOn),
                maxPerMinute: 3,
                maxPerDay: 20,
                merchantIds: ["daiso", "coupang"],
                purpose: "Event expenses",
            },
            expiresAtSource: "owner",
            ownerEdits: ["expiresAt"],
            ...over,
        };
    }
    const prepare = (body: unknown) => postJson<Record<string, unknown>>("/api/owner-actions/prepare", body, api);

    it("owner → evidence stored before any tx; setPolicy call with the evidence hash, amounts as strings", async () => {
        const r = await prepare(await policyBody(d.owner));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.data).toMatchObject({ vault: getAddress(d.vault), chainId: hardhat.id, evidenceId: expect.any(String) });
        const call = r.data.call as { functionName: string; args: [Record<string, unknown>, Hex] };
        expect(call.functionName).toBe("setPolicy");
        expect(call.args[0]).toMatchObject({ budget: "200000", approvalThreshold: "50000", maxPerMinute: 3, maxPerDay: 20 });
        expect(call.args[1]).toBe(r.data.evidenceHash);
        expect(c.evidence.findById(r.data.evidenceId as string)).toMatchObject({ kind: "policy_set", anchor: null });
    });

    it("non-owner address → 403 NOT_OWNER, nothing stored", async () => {
        const before = c.evidence.listByVault(hardhat.id, getAddress(d.vault)).length;
        expect(await prepare(await policyBody(d.agent))).toMatchObject({ ok: false, status: 403, error: { code: "NOT_OWNER" } });
        expect(c.evidence.listByVault(hardhat.id, getAddress(d.vault)).length).toBe(before);
    });

    it("missing expiry → 422 EXPIRY_REQUIRED; past expiry → 422 SCHEMA_INVALID", async () => {
        const body = await policyBody(d.owner);
        expect(await prepare({ ...body, final: { ...body.final, expiresAt: 0 } })).toMatchObject({ ok: false, status: 422, error: { code: "EXPIRY_REQUIRED" } });
        expect(await prepare({ ...body, final: { ...body.final, expiresAt: 1_000 } })).toMatchObject({ ok: false, status: 422, error: { code: "SCHEMA_INVALID" } });
    });

    it("unknown merchant id → 422 UNKNOWN_MERCHANT; malformed body → 400", async () => {
        const body = await policyBody(d.owner);
        expect(await prepare({ ...body, final: { ...body.final, merchantIds: ["amazon"] } })).toMatchObject({ ok: false, status: 422, error: { code: "UNKNOWN_MERCHANT" } });
        expect(await prepare({ kind: "policy_set" })).toMatchObject({ ok: false, status: 400, error: { code: "VALIDATION_FAILED" } });
        expect(await prepare({ kind: "unpause", owner: d.owner, note: "" })).toMatchObject({ ok: false, status: 400 });
    });

    it("approval for a request with no stored evidence → 404 NOT_FOUND", async () => {
        expect(await prepare({ kind: "approval", owner: d.owner, requestId: `0x${"cd".repeat(32)}` })).toMatchObject({ ok: false, status: 404, error: { code: "NOT_FOUND" } });
    });

    it("confirm: unknown evidence → 404; a tx that does not carry the hash → 400", async () => {
        const confirm = (body: unknown) => postJson("/api/owner-actions/confirm", body, api);
        expect(await confirm({ evidenceId: "nope", txHash: `0x${"ab".repeat(32)}` })).toMatchObject({ ok: false, status: 404, error: { code: "NOT_FOUND" } });
        const r = await prepare({ kind: "pause", owner: d.owner, note: "" });
        if (!r.ok) throw new Error("prepare failed");
        // the vault deployment tx exists but has no PolicyVault event with this evidence hash
        const { publicClient } = await import("./helpers/chain");
        const block = await publicClient.getBlock({ blockNumber: d.deployBlock });
        expect(await confirm({ evidenceId: r.data.evidenceId, txHash: block.transactions[0] })).toMatchObject({
            ok: false,
            status: 400,
            error: { code: "VALIDATION_FAILED" },
        });
    });
});
