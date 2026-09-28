import { getAddress, parseEventLogs, type Hex } from "viem";
import { hardhat } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { policyVaultAbi } from "@/adapters/chain/generated/PolicyVault";
import { createViemAgentWriter } from "@/adapters/chain/viemVault";
import { parseServerEnv } from "@/config/env";
import { expiresOnToUnix, kstDate } from "@/core/domain/policy";
import { processSpendRequest } from "@/core/usecases/processSpendRequest";
import { postJson, requestJson } from "@/ui/apiClient";
import { buildPolicySetBody, formFromCandidate, type CandidateDto } from "@/ui/delegate/delegateState";
import { createWalletPorts, runOwnerAction, type OwnerActionState, type PreparedAction } from "@/ui/wallet/ownerAction";
import { apiFetch, deploymentOf, walletShim } from "./helpers/api";
import { deployVault, freshMinute, latestTimestamp, publicClient, walletClient, type Deployed } from "./helpers/chain";
import { INTEGRATION_RPC_URL } from "./helpers/rpc";

// Browser owner path end to end, minus the browser: Route Handlers in-process + the UI's wallet ports (viem custom
// EIP-1193 transport) + a real PolicyVault. Covers F-02 (register), F-04 ② (approve), F-05 ① (pause) and the
// failure states the dashboard shows (not owner, signature rejected, contract revert before signing).
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
    c = createAppContainer(env, { deployment: deploymentOf(d), confirm: { timeoutMs: 20_000, pollMs: 100 } });
    api = apiFetch(c);
});
afterEach(() => c.close());

async function run(account: Hex, body: unknown, refuse: string[] = []) {
    const provider = walletShim(account, { refuse });
    const ports = createWalletPorts({ provider, account, fetchImpl: api });
    const steps: string[] = [];
    const final = await runOwnerAction(ports, body as never, (s: OwnerActionState) => steps.push(s.step), { walletChainId: hardhat.id });
    return { final, steps, provider, ports };
}

async function registerViaWallet() {
    const parsed = await postJson<{ parseCallId: string; candidate: CandidateDto }>("/api/policy/parse", { delegationText: DEMO }, api);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error.code}`);
    const chainNow = await latestTimestamp();
    const expiresOn = kstDate(new Date((chainNow + 30 * 86_400) * 1000));
    const form = { ...formFromCandidate(parsed.data.candidate), expiresOn };
    const built = buildPolicySetBody({
        form,
        candidate: parsed.data.candidate,
        parseCallId: parsed.data.parseCallId,
        delegationText: DEMO,
        owner: getAddress(d.owner),
        nowSec: Math.floor(Date.now() / 1000),
    });
    if (!built.ok) throw new Error(`form invalid: ${JSON.stringify(built.errors)}`);
    return { ...(await run(getAddress(d.owner), built.body)), body: built.body, expiresOn };
}

async function logsOf(txHash: Hex) {
    const r = await publicClient.getTransactionReceipt({ hash: txHash });
    return { receipt: r, events: parseEventLogs({ abi: policyVaultAbi, logs: r.logs }) as unknown as { eventName: string; args: Record<string, unknown> }[] };
}

const spendDeps = () => ({
    chainId: hardhat.id,
    vault: getAddress(d.vault),
    deployBlock: d.deployBlock,
    reader: c.reader,
    writer: createViemAgentWriter({ walletClient, publicClient, vault: d.vault, account: d.agent, chain: hardhat }),
    kiln: c.kiln,
    evidence: c.evidence,
    kilnCalls: c.kilnCalls,
    spendRequests: c.spendRequests,
    chainEvents: c.chainEvents,
    merchants: c.merchants,
    clock: { now: () => new Date() },
});

describe("F-02 — policy registered by the owner's wallet signature", () => {
    it("walks every step; on-chain policy equals the confirmed values; PolicySet sender is the owner; evidence anchored", async () => {
        const { final, steps, body, expiresOn } = await registerViaWallet();
        expect(steps).toEqual(["preparing", "simulating", "awaiting_signature", "confirming", "done"]);
        expect(final.step).toBe("done");
        if (final.step !== "done") return;

        const { receipt, events } = await logsOf(final.txHash);
        expect(getAddress(receipt.from)).toBe(getAddress(d.owner));
        const set = events.find((e) => e.eventName === "PolicySet")!;
        expect(getAddress(set.args.by as Hex)).toBe(getAddress(d.owner));
        expect(set.args.evidenceHash).toBe(final.evidenceHash);

        const state = await requestJson<{ state: Record<string, unknown> }>("/api/vault/state", undefined, api);
        if (!state.ok) throw new Error("state failed");
        expect(state.data.state).toMatchObject({
            policyVersion: "1",
            budget: "200000",
            approvalThreshold: "50000",
            expiresAt: expiresOnToUnix(expiresOn),
            maxPerMinute: 3,
            maxPerDay: 20,
            merchants: [getAddress("0x000000000000000000000000000000000000da15"), getAddress("0x000000000000000000000000000000000000c0a9")],
        });
        expect(body.final.expiresAt).toBe(expiresOnToUnix(expiresOn));

        const ev = c.evidence.findByHash(final.evidenceHash)!;
        expect(ev.anchor?.txHash).toBe(final.txHash);
        expect(JSON.parse(ev.packageJson)).toMatchObject({ kind: "policy_set", final: { expiresAtSource: "owner" }, ownerEdits: ["expiresAt"] });

        const activity = await requestJson<{ items: { kind: string; txHash: Hex }[] }>("/api/vault/activity", undefined, api);
        expect(activity.ok && activity.data.items).toEqual([expect.objectContaining({ kind: "policy_set", txHash: final.txHash })]);
    });

    it("a non-owner wallet is stopped by the server guard before any wallet call (403 NOT_OWNER)", async () => {
        const parsed = await postJson<{ parseCallId: string; candidate: CandidateDto }>("/api/policy/parse", { delegationText: DEMO }, api);
        if (!parsed.ok) throw new Error("parse failed");
        const built = buildPolicySetBody({
            form: { ...formFromCandidate(parsed.data.candidate), expiresOn: kstDate(new Date(((await latestTimestamp()) + 30 * 86_400) * 1000)) },
            candidate: parsed.data.candidate,
            parseCallId: parsed.data.parseCallId,
            delegationText: DEMO,
            owner: getAddress(d.agent),
            nowSec: Math.floor(Date.now() / 1000),
        });
        if (!built.ok) throw new Error("form invalid");
        const { final, provider } = await run(getAddress(d.agent), built.body);
        expect(final).toMatchObject({ step: "error", at: "preparing", error: { code: "NOT_OWNER" } });
        expect(provider.sent.filter((s) => s.method === "eth_sendTransaction")).toEqual([]);
    });

    it("the contract is the authority: a non-owner signer fails in simulation with CONTRACT_NOT_OWNER (nothing sent)", async () => {
        const owner = await postJson<PreparedAction>("/api/owner-actions/prepare", { kind: "pause", owner: d.owner, note: "" }, api);
        if (!owner.ok) throw new Error("prepare failed");
        const provider = walletShim(getAddress(d.agent));
        const ports = createWalletPorts({ provider, account: getAddress(d.agent), fetchImpl: api });
        await expect(ports.simulate(owner.data)).rejects.toMatchObject({ code: "CONTRACT_NOT_OWNER" });
        expect(provider.sent.filter((s) => s.method === "eth_sendTransaction")).toEqual([]);
    });

    it("signature rejected in the wallet → SIGNATURE_REJECTED, no tx, policy unchanged", async () => {
        const { final } = await run(getAddress(d.owner), { kind: "pause", owner: d.owner, note: "" }, ["eth_sendTransaction"]);
        expect(final).toEqual({ step: "error", at: "awaiting_signature", error: { code: "SIGNATURE_REJECTED", message: "Signature rejected" }, txHash: null });
        const state = await requestJson<{ state: { paused: boolean } }>("/api/vault/state", undefined, api);
        expect(state.ok && state.data.state.paused).toBe(false);
    });
});

describe("F-04 ② / F-10 — pending inbox approval and receipts", () => {
    it("over-threshold request → pending in activity → owner approves by wallet → Approved(owner) + SpendExecuted(viaApproval) → receipt", async () => {
        const reg = await registerViaWallet();
        expect(reg.final.step).toBe("done");

        const out = await processSpendRequest(spendDeps(), { merchantId: "coupang", amount: 60_000n, itemDescription: "Portable speaker for the event" });
        expect(out.outcome).toBe("pending");

        const before = await requestJson<{ items: { kind: string; requestId: Hex; flags: number | null; amount: string | null; merchantId: string | null; judgmentStatus: string | null }[] }>(
            "/api/vault/activity",
            undefined,
            api,
        );
        if (!before.ok) throw new Error("activity failed");
        expect(before.data.items.at(-1)).toMatchObject({ kind: "pending", requestId: out.requestId, flags: 1, amount: "60000", merchantId: "coupang", judgmentStatus: "match" });

        const { final, steps } = await run(getAddress(d.owner), { kind: "approval", owner: d.owner, requestId: out.requestId });
        expect(steps).toEqual(["preparing", "simulating", "awaiting_signature", "confirming", "done"]);
        if (final.step !== "done") throw new Error(JSON.stringify(final));
        const { events } = await logsOf(final.txHash);
        expect(events.map((e) => e.eventName)).toEqual(["Approved", "SpendExecuted"]);
        expect(getAddress(events[0].args.approver as Hex)).toBe(getAddress(d.owner));
        expect(events[1].args.viaApproval).toBe(true);

        const receipt = await requestJson<{ receipt: Record<string, unknown> }>(`/api/receipts/${out.requestId}`, undefined, api);
        if (!receipt.ok) throw new Error(`receipt failed: ${receipt.error.code}`);
        expect(receipt.data.receipt).toMatchObject({
            requestId: out.requestId,
            amount: "60000",
            fee: "600",
            merchant: { id: "coupang", name: "Coupang", address: getAddress("0x000000000000000000000000000000000000c0a9") },
            txHash: final.txHash,
            evidenceHash: out.evidenceHash,
            judgmentSummary: { status: "match", reason: expect.any(String), provider: "fake" },
            viaApproval: true,
            approver: getAddress(d.owner),
        });

        const after = await requestJson<{ items: { kind: string; requestId: Hex | null }[] }>("/api/vault/activity", undefined, api);
        expect(after.ok && after.data.items.slice(-2).map((i) => i.kind)).toEqual(["approved", "executed"]);
    });

    it("rejection by wallet → Rejected(owner); a directly executed payment has a receipt without approver; blocked has none", async () => {
        await registerViaWallet();
        const pend = await processSpendRequest(spendDeps(), { merchantId: "daiso", amount: 15_000n, itemDescription: "Personal gaming mouse" });
        expect(pend).toMatchObject({ outcome: "pending", pendingFlags: 2 });
        const { final } = await run(getAddress(d.owner), { kind: "rejection", owner: d.owner, requestId: pend.requestId });
        if (final.step !== "done") throw new Error(JSON.stringify(final));
        const { events } = await logsOf(final.txHash);
        expect(events.map((e) => e.eventName)).toEqual(["Rejected"]);
        expect(await requestJson(`/api/receipts/${pend.requestId}`, undefined, api)).toMatchObject({ ok: false, status: 404 });

        const paid = await processSpendRequest(spendDeps(), { merchantId: "daiso", amount: 30_000n, itemDescription: "Balloons for the welcome party" });
        expect(paid.outcome).toBe("executed");
        const r = await requestJson<{ receipt: Record<string, unknown> }>(`/api/receipts/${paid.requestId}`, undefined, api);
        expect(r.ok && r.data.receipt).toMatchObject({ amount: "30000", fee: "300", txHash: paid.txHash, evidenceHash: paid.evidenceHash, viaApproval: false, approver: null });

        const blocked = await processSpendRequest(spendDeps(), { merchantId: "gmarket", amount: 20_000n, itemDescription: "Snacks" });
        expect(blocked.outcome).toBe("blocked");
        expect(await requestJson(`/api/receipts/${blocked.requestId}`, undefined, api)).toMatchObject({ ok: false, status: 404 });
        const act = await requestJson<{ items: { kind: string; reason: number | null; requestId: Hex | null }[] }>("/api/vault/activity", undefined, api);
        expect(act.ok && act.data.items.find((i) => i.requestId === blocked.requestId)).toMatchObject({ kind: "blocked", reason: 6 });
    });
});

describe("F-05 ① — pause by wallet", () => {
    it("VaultPaused sent by the owner; state paused; a second pause fails in simulation (CONTRACT_ALREADY_PAUSED)", async () => {
        const { final } = await run(getAddress(d.owner), { kind: "pause", owner: d.owner, note: "Stop all spending" });
        if (final.step !== "done") throw new Error(JSON.stringify(final));
        const { receipt, events } = await logsOf(final.txHash);
        expect(getAddress(receipt.from)).toBe(getAddress(d.owner));
        expect(events.map((e) => e.eventName)).toEqual(["VaultPaused"]);
        expect(getAddress(events[0].args.by as Hex)).toBe(getAddress(d.owner));

        const state = await requestJson<{ state: { paused: boolean } }>("/api/vault/state", undefined, api);
        expect(state.ok && state.data.state.paused).toBe(true);

        const again = await run(getAddress(d.owner), { kind: "pause", owner: d.owner, note: "" });
        expect(again.final).toMatchObject({ step: "error", at: "simulating", error: { code: "CONTRACT_ALREADY_PAUSED" } });
        expect(again.provider.sent.filter((s) => s.method === "eth_sendTransaction")).toEqual([]);
    });
});
