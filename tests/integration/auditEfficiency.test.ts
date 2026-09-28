import type Database from "better-sqlite3";
import { getAddress, type Hex } from "viem";
import { hardhat } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViemAgentWriter } from "@/adapters/chain/viemVault";
import { openDatabase } from "@/adapters/db/sqlite";
import { parseServerEnv } from "@/config/env";
import { kstDate } from "@/core/domain/policy";
import { processSpendRequest } from "@/core/usecases/processSpendRequest";
import { postJson, requestJson } from "@/ui/apiClient";
import { buildPolicySetBody, formFromCandidate, type CandidateDto } from "@/ui/delegate/delegateState";
import { createWalletPorts, runOwnerAction } from "@/ui/wallet/ownerAction";
import { apiFetch, deploymentOf, walletShim } from "./helpers/api";
import { deployVault, freshMinute, latestTimestamp, publicClient, walletClient, type Deployed } from "./helpers/chain";
import { INTEGRATION_RPC_URL } from "./helpers/rpc";

// ③ Audit (F-13) and ④ Efficiency (F-14) Route Handlers against a real Hardhat node + SQLite + fake Kiln.
vi.mock("server-only", () => ({}));
const { createAppContainer } = await import("@/server/container");
type AppContainer = import("@/server/container").AppContainer;

const DEMO = "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐";
const env = parseServerEnv({ RPC_URL: INTEGRATION_RPC_URL, DATABASE_PATH: ":memory:", KILN_MODE: "fake" });
const UNKNOWN_TX = `0x${"ab".repeat(32)}` as Hex;

let d: Deployed;
let db: Database.Database;
let c: AppContainer;
let api: typeof fetch;
beforeEach(async () => {
    await freshMinute();
    d = await deployVault();
    db = openDatabase(":memory:");
    c = createAppContainer(env, { deployment: deploymentOf(d), db, confirm: { timeoutMs: 20_000, pollMs: 100 } });
    api = apiFetch(c);
});
afterEach(() => {
    c.close();
    db.close();
});

async function registerViaWallet(): Promise<Hex> {
    const parsed = await postJson<{ parseCallId: string; candidate: CandidateDto }>("/api/policy/parse", { delegationText: DEMO }, api);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error.code}`);
    const expiresOn = kstDate(new Date(((await latestTimestamp()) + 30 * 86_400) * 1000));
    const built = buildPolicySetBody({
        form: { ...formFromCandidate(parsed.data.candidate), expiresOn },
        candidate: parsed.data.candidate,
        parseCallId: parsed.data.parseCallId,
        delegationText: DEMO,
        owner: getAddress(d.owner),
        nowSec: Math.floor(Date.now() / 1000),
    });
    if (!built.ok) throw new Error(`form invalid: ${JSON.stringify(built.errors)}`);
    const account = getAddress(d.owner);
    const ports = createWalletPorts({ provider: walletShim(account), account, fetchImpl: api });
    const final = await runOwnerAction(ports, built.body as never, () => {}, { walletChainId: hardhat.id });
    if (final.step !== "done") throw new Error(JSON.stringify(final));
    return final.txHash;
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

type AuditItem = { event: string; args: Record<string, unknown>; evidenceKind: string | null; package: unknown; hashMatch: boolean | null; withinPolicy: boolean | null; blockReason: string | null; recomputedHash: string | null; onchainHash: string };
type Audit = { result: { status: "not_found" } | { status: "found"; txHash: string; blockNumber: string; items: AuditItem[] } };
type Report = { report: { provider: string; rows: Record<string, unknown>[]; totals: Record<string, unknown>; savings: Record<string, number>; energy: { disclaimer: string } } };
const audit = (tx: string) => requestJson<Audit>(`/api/audit/${tx}`, undefined, api);
const efficiency = () => requestJson<Report>("/api/efficiency", undefined, api);

describe("GET /api/audit/[txHash] (F-13)", () => {
    it("executed, blocked and policy txs → evidence re-hashed = on-chain hash; blocked shows the reason (①②)", async () => {
        const policyTx = await registerViaWallet();
        const paid = await processSpendRequest(spendDeps(), { merchantId: "daiso", amount: 30_000n, itemDescription: "Balloons for the welcome party" });
        const blocked = await processSpendRequest(spendDeps(), { merchantId: "gmarket", amount: 20_000n, itemDescription: "Snacks" });
        expect([paid.outcome, blocked.outcome]).toEqual(["executed", "blocked"]);

        const p = await audit(paid.txHash as Hex);
        if (!p.ok || p.data.result.status !== "found") throw new Error(JSON.stringify(p));
        expect(p.data.result.txHash).toBe(paid.txHash);
        expect(p.data.result.items).toHaveLength(1);
        expect(p.data.result.items[0]).toMatchObject({
            event: "SpendExecuted",
            evidenceKind: "spend_request",
            hashMatch: true,
            withinPolicy: true,
            blockReason: null,
            onchainHash: paid.evidenceHash,
            recomputedHash: paid.evidenceHash,
            args: { amount: "30000", fee: "300" },
            package: { requestId: paid.requestId, request: { merchantId: "daiso", amount: "30000" } },
        });

        const b = await audit(blocked.txHash as Hex);
        expect(b.ok && b.data.result.status === "found" && b.data.result.items[0]).toMatchObject({
            event: "SpendBlocked",
            hashMatch: true,
            withinPolicy: null,
            blockReason: "Merchant not allowed",
            package: { precheck: { verdict: "block" }, judgment: null },
        });

        const pol = await audit(policyTx);
        expect(pol.ok && pol.data.result.status === "found" && pol.data.result.items.map((i) => [i.event, i.evidenceKind, i.hashMatch])).toEqual([["PolicySet", "policy_set", true]]);
    });

    it("unknown tx hash → ok with status not_found (③); upper-case hex accepted", async () => {
        expect(await audit(UNKNOWN_TX)).toMatchObject({ ok: true, data: { result: { status: "not_found" } } });
        expect(await audit(`0x${"AB".repeat(32)}`)).toMatchObject({ ok: true, data: { result: { status: "not_found" } } });
    });

    it("malformed hash (too short, not hex, empty-ish) → 400 VALIDATION_FAILED", async () => {
        for (const bad of ["0x1234", `0x${"zz".repeat(32)}`, "abc"])
            expect(await audit(bad)).toMatchObject({ ok: false, status: 400, error: { code: "VALIDATION_FAILED" } });
    });

    it("RPC unreachable → 502 CHAIN_RPC_ERROR", async () => {
        c.close();
        c = createAppContainer(parseServerEnv({ RPC_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:" }), { deployment: deploymentOf(d) });
        api = apiFetch(c);
        const r = await audit(UNKNOWN_TX);
        expect(r).toMatchObject({ ok: false, status: 502, error: { code: "CHAIN_RPC_ERROR" } });
        expect(JSON.stringify(r)).not.toContain("127.0.0.1:1");
    });
});

describe("GET /api/efficiency (F-14)", () => {
    it("no Kiln calls → 0 rows, zero totals (빈 값)", async () => {
        const r = await efficiency();
        if (!r.ok) throw new Error(JSON.stringify(r));
        expect(r.data.report.rows).toEqual([]);
        expect(r.data.report.totals).toMatchObject({ kilnCalls: 0, totalTokens: 0, costUsd: "0", energyWhUpper: 0 });
        expect(r.data.report.energy.disclaimer).toMatch(/not measured/i);
    });

    it("parse + judged spend + rule-blocked spend → per-flow rows, rule_block 0 tokens, totals = SQLite sums (①③)", async () => {
        await registerViaWallet();
        await processSpendRequest(spendDeps(), { merchantId: "daiso", amount: 30_000n, itemDescription: "Balloons for the welcome party" });
        await processSpendRequest(spendDeps(), { merchantId: "gmarket", amount: 20_000n, itemDescription: "Snacks" });

        const r = await efficiency();
        if (!r.ok) throw new Error(JSON.stringify(r));
        const { report } = r.data;
        expect(report.provider).toBe("fake");
        expect(report.rows.map((x) => [x.flow, x.kilnCalls, x.requests])).toEqual([
            ["policy_parse", 1, 1],
            ["intent_judge", 1, 1],
            ["rule_block", 0, 1],
        ]);
        expect(report.rows[2]).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0, energyWhUpper: 0 });
        const sql = db
            .prepare("SELECT count(*) n, SUM(prompt_tokens) p, SUM(completion_tokens) c, SUM(total_tokens) t, TOTAL(CAST(cost_usd AS REAL)) cost FROM kiln_calls")
            .get() as { n: number; p: number; c: number; t: number; cost: number };
        expect(report.totals).toMatchObject({ kilnCalls: sql.n, promptTokens: sql.p, completionTokens: sql.c, totalTokens: sql.t });
        expect(Number(report.totals.costUsd)).toBeCloseTo(sql.cost, 10);
        expect(report.savings.ruleBlockedRequests).toBe(1);
    });
});
