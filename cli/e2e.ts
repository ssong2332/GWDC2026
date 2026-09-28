import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getAddress } from "viem";
import { NETWORKS, explorerTxUrl, readDeploymentFile, writeDeploymentFile, type DeploymentFile } from "@/adapters/chain/networks";
import { withReadRetry } from "@/adapters/chain/readRetry";
import { createViemAgentWriter, createViemOwnerWriter, createViemVaultReader } from "@/adapters/chain/viemVault";
import { DEFAULT_RATE_LIMITS, SECONDS_PER_MINUTE } from "@/config/constants";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import type { SpendRequestEvidence } from "@/core/domain/evidence";
import { expiresOnToUnix, kstDate } from "@/core/domain/policy";
import type { Hex, SpendOutcome, SpendRequestInput } from "@/core/domain/types";
import { AppError } from "@/core/errors";
import type { AgentVaultWriter, TxResult } from "@/core/ports";
import { parsePolicy } from "@/core/usecases/parsePolicy";
import { prepareOwnerAction, type PrepareOwnerActionInput } from "@/core/usecases/prepareOwnerAction";
import { processSpendRequest } from "@/core/usecases/processSpendRequest";
import { syncChainEvents } from "@/core/usecases/syncChainEvents";
import { loadCliEnv } from "./_env";
import { assertRpcChain, createClients, createKilnClient, isEntry, logLine, openRepos, resolveSigners, runCli } from "./_container";
import { deployContracts, parseNetwork } from "./deploy";
import { EXPORT_FILES, buildEvidenceExport, writeEvidenceExport } from "./export-evidence";
import { formatVerifyReport, verifyFile } from "./verify-evidence";

// Layer ④ E2E / demo run (Architecture "E2E 시나리오", F-15, F-12 ①). Same script for both networks:
//   npx tsx cli/e2e.ts --chain localhost|baseSepolia --kiln fake|real [--rpc <url>] [--deploy] [--skip-burst]
// Every step asserts its SpendOutcome / events; the first failed assertion exits with code 1.

const SCENARIO = {
    delegation: "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐",
    policy: { budget: 200_000n, approvalThreshold: 50_000n, merchantIds: ["daiso", "coupang"], expiryDays: 7, ...DEFAULT_RATE_LIMITS },
    localDatabase: "data.local/e2e-localhost.sqlite",
    runDir: { localhost: "data.local/evidence/localhost", baseSepolia: "evidence/base-sepolia" },
    burst: { count: 4, input: { merchantId: "coupang", amount: 1_000n, itemDescription: "Paper cups" } },
    pollMs: 3_000,
} as const;

type Row = {
    step: string;
    actor: "agent" | "owner" | "kiln+owner";
    requestId: Hex | null;
    txHash: Hex;
    explorerUrl: string | null;
    event: string;
    reason: number | null;
    flags: number | null;
    kilnCalls: number;
    tokens: number | null;
    generationId: string | null;
    precheckAgreed: boolean | null;
    gasUsed: bigint;
    feeWei: bigint;
};

function check(cond: unknown, message: string): asserts cond {
    if (!cond) throw new AppError("E2E_ASSERTION", message);
}

const EVENT_OF = { executed: "SpendExecuted", blocked: "SpendBlocked", pending: "SpendPending" } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

function table(rows: Row[]): string {
    const head = ["step", "actor", "event", "reason", "flags", "kiln", "tokens", "requestId", "txHash", "gasUsed"];
    const cells = rows.map((r) => [
        r.step,
        r.actor,
        r.event,
        r.reason === null ? "-" : String(r.reason),
        r.flags === null ? "-" : String(r.flags),
        String(r.kilnCalls),
        r.tokens === null ? "-" : String(r.tokens),
        r.requestId === null ? "-" : `${r.requestId.slice(0, 10)}…`,
        r.txHash,
        r.gasUsed.toString(),
    ]);
    const widths = head.map((h, c) => Math.max(h.length, ...cells.map((r) => r[c].length)));
    const line = (c: string[]) => c.map((x, i) => x.padEnd(widths[i])).join("  ");
    return [line(head), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n");
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            chain: { type: "string" },
            kiln: { type: "string" },
            rpc: { type: "string" },
            deploy: { type: "boolean", default: false },
            "skip-burst": { type: "boolean", default: false },
        },
    });
    if (values.kiln !== undefined && values.kiln !== "fake" && values.kiln !== "real")
        throw new AppError("VALIDATION_FAILED", `--kiln must be fake or real, got ${values.kiln}`);
    const env = loadCliEnv({ overrides: { CHAIN: values.chain, RPC_URL: values.rpc, KILN_MODE: values.kiln } });
    const network = parseNetwork(values.chain, env.chain);
    const kilnMode = env.kiln.mode;
    const startedAt = new Date();
    const { chain, publicClient, walletClient, testClient } = createClients(network, env.rpcUrl);
    await assertRpcChain(publicClient, network);
    const signers = await resolveSigners(network, env, walletClient);
    logLine("info", "e2e.start", { network, kiln: kilnMode, agent: signers.agentAddress, owner: signers.ownerAddress });

    const rows: Row[] = [];
    const spentWei = { agent: 0n, owner: 0n };
    const push = (r: Row) => {
        rows.push(r);
        spentWei[r.actor === "agent" ? "agent" : "owner"] += r.feeWei;
        const { event: onchainEvent, ...rest } = r; // `event` is the log line's own key
        logLine("info", "e2e.step", { ...rest, onchainEvent });
    };
    const base = (step: string, actor: Row["actor"], txHash: Hex, event: string) => ({
        step,
        actor,
        requestId: null,
        txHash,
        explorerUrl: explorerTxUrl(network, txHash),
        event,
        reason: null,
        flags: null,
        kilnCalls: 0,
        tokens: null,
        generationId: null,
        precheckAgreed: null,
    });

    // --- step 0: deploy (always on localhost) ---
    let deployment: DeploymentFile;
    if (network === "localhost" || values.deploy) {
        const out = await deployContracts({ network, publicClient, walletClient, chain, deployer: signers.agent, owner: signers.ownerAddress, feeRecipient: signers.feeRecipient });
        deployment = out.deployment;
        writeDeploymentFile(path.resolve(NETWORKS[network].deploymentFile), deployment);
        for (const t of out.txs) push({ ...base("0", "agent", t.txHash, t.label), gasUsed: t.gasUsed, feeWei: t.feeWei });
    } else {
        deployment = readDeploymentFile(path.resolve(NETWORKS[network].deploymentFile));
        check(
            deployment.agent === signers.agentAddress && deployment.owner === signers.ownerAddress,
            "the deployment's agent/owner are not the configured keys — rerun with --deploy",
        );
    }

    const vault = deployment.vault;
    const repos = openRepos(network === "localhost" ? SCENARIO.localDatabase : env.databasePath, { fresh: network === "localhost" });
    try {
        const reader = createViemVaultReader({ client: publicClient, vault, chainId: deployment.chainId });
        const receipts = new Map<Hex, TxResult>();
        const agentWriter = createViemAgentWriter({ walletClient, publicClient, vault, account: signers.agent, chain });
        const writer: AgentVaultWriter = {
            spend: async (a) => {
                const r = await agentWriter.spend(a);
                receipts.set(a.requestId, r);
                return r;
            },
        };
        const owner = createViemOwnerWriter({ walletClient, publicClient, vault, account: signers.owner, chain });
        const kiln = createKilnClient(env, kilnMode);
        const clock = { now: () => new Date() };
        const ctx = { chainId: deployment.chainId, vault, deployBlock: BigInt(deployment.deployBlock) };
        const { evidence, kilnCalls, spendRequests, chainEvents } = repos;
        const spendDeps = { ...ctx, reader, writer, kiln, evidence, kilnCalls, spendRequests, chainEvents, merchants: MERCHANT_REGISTRY, clock };
        const ownerDeps = { chainId: ctx.chainId, vault, vaultOwner: deployment.owner, feeBps: deployment.feeBps, evidence, kilnCalls, merchants: MERCHANT_REGISTRY, clock };
        const sync = () => syncChainEvents({ ...ctx, reader, chainEvents, evidence });

        const latestTs = async () => Number((await withReadRetry(() => publicClient.getBlock({ blockTag: "latest" }))).timestamp);
        /** Local: jump the node clock to the next minute start. Base Sepolia: poll until a block lands in the next minute. */
        const waitForFreshMinute = async () => {
            const next = (Math.floor((await latestTs()) / SECONDS_PER_MINUTE) + 1) * SECONDS_PER_MINUTE;
            if (testClient) {
                await testClient.setNextBlockTimestamp({ timestamp: BigInt(next) });
                await testClient.mine({ blocks: 1 });
                return;
            }
            while ((await latestTs()) < next) await sleep(SCENARIO.pollMs);
        };
        const ensureMinuteCapacity = async (n: number) => {
            const s = await reader.getState();
            const used = s.minuteBucket === BigInt(Math.floor(s.blockTimestamp / SECONDS_PER_MINUTE)) ? s.minuteCount : 0;
            if (used + n > s.maxPerMinute) await waitForFreshMinute();
        };
        const remaining = () => reader.remainingBudget();

        const spendRow = (step: string, out: SpendOutcome): Row => {
            const r = receipts.get(out.requestId);
            const row = evidence.findByHash(out.evidenceHash);
            check(r && row, `step ${step}: missing receipt or evidence for ${out.requestId}`);
            const pkg = JSON.parse(row.packageJson) as SpendRequestEvidence;
            return {
                ...base(step, "agent", out.txHash, EVENT_OF[out.outcome]),
                requestId: out.requestId,
                reason: out.blockReason,
                flags: out.pendingFlags,
                kilnCalls: out.kilnCalls,
                tokens: pkg.judgment?.kiln.usage.totalTokens ?? null,
                generationId: pkg.judgment?.kiln.generationId ?? null,
                precheckAgreed: out.precheckAgreed,
                gasUsed: r.receipt.gasUsed,
                feeWei: r.receipt.feeWei,
            };
        };
        const spend = async (
            step: string,
            input: SpendRequestInput,
            want: { outcome: SpendOutcome["outcome"]; reason?: number; flags?: number; kilnCalls: 0 | 1; remaining?: bigint },
        ) => {
            await ensureMinuteCapacity(1);
            const out = await processSpendRequest(spendDeps, input);
            push(spendRow(step, out));
            check(out.outcome === want.outcome, `step ${step}: outcome ${out.outcome}, expected ${want.outcome}`);
            check(out.kilnCalls === want.kilnCalls, `step ${step}: ${out.kilnCalls} Kiln calls, expected ${want.kilnCalls}`);
            if (want.reason !== undefined) check(out.blockReason === want.reason, `step ${step}: reason ${out.blockReason}, expected ${want.reason}`);
            if (want.flags !== undefined) check(out.pendingFlags === want.flags, `step ${step}: flags ${out.pendingFlags}, expected ${want.flags}`);
            if (want.remaining !== undefined) {
                const left = await remaining();
                check(left === want.remaining, `step ${step}: remaining ${left}, expected ${want.remaining}`);
            }
            return out;
        };
        const ownerStep = async (step: string, input: PrepareOwnerActionInput, send: (hash: Hex) => Promise<TxResult>, events: string[], extra: Partial<Row> = {}) => {
            const prep = await prepareOwnerAction(ownerDeps, input);
            const tx = await send(prep.evidenceHash);
            const names = tx.receipt.events.map((e) => e.name);
            push({ ...base(step, "owner", tx.txHash, names.join("+")), requestId: "requestId" in input ? input.requestId : null, gasUsed: tx.receipt.gasUsed, feeWei: tx.receipt.feeWei, ...extra });
            check(tx.receipt.status === "success" && names.join() === events.join(), `step ${step}: events ${names.join()}, expected ${events.join()}`);
            check(tx.receipt.events[0].args.evidenceHash === prep.evidenceHash, `step ${step}: event evidenceHash differs from the prepared evidence`);
            await sync();
            return tx;
        };

        // --- step 1: Kiln parses the delegation, the owner confirms (expiry from the script) and signs setPolicy ---
        check((await reader.getState()).pendingCount === 0, "the vault has pending requests (setPolicy would revert) — rerun with --deploy");
        const parsed = await parsePolicy({ kiln, kilnCalls, merchants: MERCHANT_REGISTRY, clock, chainId: ctx.chainId, vault }, { delegationText: SCENARIO.delegation });
        check(parsed.ok, `step 1: policy parse failed — ${parsed.ok ? "" : `${parsed.code}: ${parsed.message}`}`);
        const want = SCENARIO.policy;
        const expiryDate = kstDate(new Date(Date.now() + want.expiryDays * 86_400_000));
        const expiresAt = expiresOnToUnix(expiryDate);
        check(expiresAt !== null, "step 1: could not compute the expiry");
        const c = parsed.candidate;
        const ownerEdits = [
            c.budget !== want.budget && "budget",
            c.approvalThreshold !== want.approvalThreshold && "approvalThreshold",
            [...c.merchantIds].sort().join() !== [...want.merchantIds].sort().join() && "merchantIds",
            c.expiresOn !== expiryDate && "expiresAt",
        ].filter((x): x is string => typeof x === "string");
        const final = {
            budget: want.budget,
            approvalThreshold: want.approvalThreshold,
            expiresAt,
            maxPerMinute: want.maxPerMinute,
            maxPerDay: want.maxPerDay,
            merchantIds: [...want.merchantIds],
            purpose: c.purpose,
        };
        const parseCall = kilnCalls.findById(parsed.parseCallId);
        const policyTx = await ownerStep(
            "1",
            { kind: "policy_set", owner: signers.ownerAddress, parseCallId: parsed.parseCallId, delegationText: SCENARIO.delegation, final, expiresAtSource: "owner", ownerEdits },
            (hash) =>
                owner.setPolicy(
                    { ...final, merchants: final.merchantIds.map((id) => getAddress(MERCHANT_REGISTRY.find((m) => m.id === id)!.address)) },
                    hash,
                ),
            ["PolicySet"],
            { actor: "kiln+owner", kilnCalls: 1, tokens: parseCall?.totalTokens ?? null, generationId: parseCall?.generationId ?? null },
        );
        check(getAddress(String(policyTx.receipt.events[0].args.by)) === signers.ownerAddress, "step 1: PolicySet was not sent by the owner");

        // --- steps 2–6 ---
        await spend("2", { merchantId: "daiso", amount: 30_000n, itemDescription: "Balloons and table decorations for the welcome party" }, { outcome: "executed", kilnCalls: 1, remaining: 169_700n });
        await spend("3", { merchantId: "gmarket", amount: 20_000n, itemDescription: "Snacks" }, { outcome: "blocked", reason: 6, kilnCalls: 0, remaining: 169_700n });
        const big = await spend("4", { merchantId: "coupang", amount: 60_000n, itemDescription: "Portable speaker for the event" }, { outcome: "pending", flags: 1, kilnCalls: 1 });
        const approved = await ownerStep("4", { kind: "approval", owner: signers.ownerAddress, requestId: big.requestId }, (hash) => owner.approve(big.requestId, hash), ["Approved", "SpendExecuted"]);
        check(approved.receipt.events[1].args.viaApproval === true, "step 4: SpendExecuted is not viaApproval");
        check((await remaining()) === 109_100n, "step 4: remaining after approval is not 109,100");
        await spend("5", { merchantId: "daiso", amount: 15_000n, itemDescription: "Personal gaming mouse" }, { outcome: "pending", flags: 2, kilnCalls: 1, remaining: 93_950n });
        await spend("6", { merchantId: "coupang", amount: await remaining(), itemDescription: "Banner printing" }, { outcome: "blocked", reason: 7, kilnCalls: 0, remaining: 93_950n });

        // --- step 7: burst — 4 concurrent requests in one fresh minute: exactly 3 execute, 1 RATE_LIMIT_MINUTE (F-08) ---
        if (!values["skip-burst"]) {
            await waitForFreshMinute();
            const outs = await Promise.all(Array.from({ length: SCENARIO.burst.count }, () => processSpendRequest(spendDeps, { ...SCENARIO.burst.input })));
            for (const o of outs) push(spendRow("7", o));
            const minutes = new Set(
                outs.map((o) => {
                    const e = receipts.get(o.requestId)!.receipt.events.find((x) => x.args.requestId === o.requestId)!;
                    return Math.floor(e.blockTimestamp / SECONDS_PER_MINUTE);
                }),
            );
            if (minutes.size > 1) throw new AppError("E2E_STRADDLED_MINUTE", "straddled minute boundary — the burst spanned two minute buckets, rerun");
            const executed = outs.filter((o) => o.outcome === "executed").length;
            const limited = outs.filter((o) => o.outcome === "blocked" && o.blockReason === 4).length;
            check(executed === 3 && limited === 1, `step 7: ${executed} executed + ${limited} RATE_LIMIT_MINUTE, expected 3 + 1`);
            check((await remaining()) === 93_950n - 3n * 1_010n, "step 7: remaining is not 90,920");
        }

        // --- step 8: pause → blocked(PAUSED) → unpause ---
        await ensureMinuteCapacity(1);
        await ownerStep("8", { kind: "pause", owner: signers.ownerAddress, note: "E2E pause" }, (hash) => owner.pause(hash), ["VaultPaused"]);
        const afterBurst = await remaining();
        await spend("8", { merchantId: "daiso", amount: 5_000n, itemDescription: "Tape" }, { outcome: "blocked", reason: 1, kilnCalls: 0, remaining: afterBurst });
        await ownerStep("8", { kind: "unpause", owner: signers.ownerAddress, note: "E2E resume" }, (hash) => owner.unpause(hash), ["VaultUnpaused"]);

        // --- evidence export + third-party verification (F-12 ①) ---
        await sync();
        const exp = buildEvidenceExport({ deployment, evidence, kilnCalls, now: new Date() });
        const exportFile = path.resolve(EXPORT_FILES[network]);
        writeEvidenceExport(exportFile, exp);
        const { report } = await verifyFile(exportFile, env.rpcUrl);

        console.log(`\nE2E ${network} (kiln=${kilnMode}) vault ${vault}\n${table(rows)}`);
        console.log(`\nETH spent — agent ${signers.agentAddress}: ${spentWei.agent} wei, owner ${signers.ownerAddress}: ${spentWei.owner} wei`);
        console.log(`\nverify ${path.relative(process.cwd(), exportFile)}\n${formatVerifyReport(exp, report)}`);

        const runFile = path.resolve(SCENARIO.runDir[network], `run-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
        fs.mkdirSync(path.dirname(runFile), { recursive: true });
        fs.writeFileSync(
            runFile,
            `${json({ network, chainId: deployment.chainId, vault, token: deployment.token, kiln: kilnMode, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), steps: rows, wallets: { agent: { address: signers.agentAddress, feeWei: spentWei.agent }, owner: { address: signers.ownerAddress, feeWei: spentWei.owner } }, evidenceFile: path.relative(process.cwd(), exportFile), mismatches: report.mismatches })}\n`,
            "utf8",
        );
        check(report.mismatches === 0, `evidence verification found ${report.mismatches} mismatches`);
        logLine("info", "e2e.passed", { steps: rows.length, runLog: path.relative(process.cwd(), runFile), evidence: path.relative(process.cwd(), exportFile), mismatches: 0 });
    } finally {
        repos.db.close();
    }
}

if (isEntry(import.meta.url)) runCli(main);
