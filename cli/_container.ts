import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, nonceManager, type Account, type Address, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS, viemChain, type NetworkName } from "@/adapters/chain/networks";
import { createChainEventRepo } from "@/adapters/db/chainEventRepo";
import { createEvidenceRepo } from "@/adapters/db/evidenceRepo";
import { createKilnCallRepo } from "@/adapters/db/kilnCallRepo";
import { openDatabase } from "@/adapters/db/sqlite";
import { createSpendRequestRepo } from "@/adapters/db/spendRequestRepo";
import { FakeKilnClient, defaultFakeHandler } from "@/adapters/kiln/fakeKilnClient";
import { OpenAiKilnClient } from "@/adapters/kiln/openaiKilnClient";
import type { CliEnv } from "@/config/env";
import type { Hex } from "@/core/domain/types";
import { AppError } from "@/core/errors";
import type { ChainEventRepo, EvidenceRepo, KilnCallRepo, KilnClient, SpendRequestRepo } from "@/core/ports";

// CLI composition root (Architecture 구조 개요): the only place that holds wallet keys. Never imports src/server/**.

export type CliRepos = {
    db: Database.Database;
    evidence: EvidenceRepo;
    kilnCalls: KilnCallRepo;
    spendRequests: SpendRequestRepo;
    chainEvents: ChainEventRepo;
};

/** Opens the SQLite file (creating its directory). `fresh` deletes the file first (e2e:local starts clean). */
export function openRepos(dbPath: string, opts: { fresh?: boolean } = {}): CliRepos {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    if (opts.fresh) for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    const db = openDatabase(dbPath);
    return {
        db,
        evidence: createEvidenceRepo(db),
        kilnCalls: createKilnCallRepo(db),
        spendRequests: createSpendRequestRepo(db),
        chainEvents: createChainEventRepo(db),
    };
}

export function createClients(network: NetworkName, rpcUrl: string) {
    const chain: Chain = viemChain(network, rpcUrl);
    const transport = http(rpcUrl);
    return {
        chain,
        publicClient: createPublicClient({ chain, transport }),
        walletClient: createWalletClient({ chain, transport }),
        testClient: network === "localhost" ? createTestClient({ chain, mode: "hardhat", transport }) : null,
    };
}

/** Refuses to run against an RPC of a different chain (e.g. RPC_URL still pointing at the local node). */
export async function assertRpcChain(publicClient: { getChainId(): Promise<number> }, network: NetworkName): Promise<void> {
    let id: number;
    try {
        id = await publicClient.getChainId();
    } catch (err) {
        throw new AppError("CHAIN_RPC_ERROR", `cannot reach the ${network} RPC (is the node running?)`, true, { cause: err });
    }
    if (id !== NETWORKS[network].chainId)
        throw new AppError("CHAIN_MISMATCH", `RPC answers chain ${id}, expected ${NETWORKS[network].chainId} for ${network} — check RPC_URL / --rpc`);
}

export type CliSigners = { agent: Account | Address; owner: Account | Address; agentAddress: Hex; ownerAddress: Hex; feeRecipient: Hex };

/**
 * localhost: the node's own unlocked accounts (#0 deployer = agent, #1 owner, #2 fee recipient) — no keys in code.
 * baseSepolia: AGENT/OWNER private keys from .env.cli (nonceManager for concurrent agent txs); OWNER_ADDRESS must
 * be the owner key's address.
 */
export async function resolveSigners(network: NetworkName, env: CliEnv, walletClient: { getAddresses(): Promise<readonly Address[]> }): Promise<CliSigners> {
    if (network === "localhost") {
        const [agent, owner, feeRecipient] = await walletClient.getAddresses();
        if (!agent || !owner || !feeRecipient) throw new AppError("CHAIN_RPC_ERROR", "the local node exposes fewer than 3 accounts");
        return { agent, owner, agentAddress: getAddress(agent), ownerAddress: getAddress(owner), feeRecipient: getAddress(feeRecipient) };
    }
    if (!env.agentPrivateKey || !env.ownerPrivateKey || !env.ownerAddress || !env.feeRecipientAddress)
        throw new AppError("ENV_INVALID", "baseSepolia needs AGENT_PRIVATE_KEY, OWNER_PRIVATE_KEY, OWNER_ADDRESS, FEE_RECIPIENT_ADDRESS");
    const agent = privateKeyToAccount(env.agentPrivateKey, { nonceManager });
    const owner = privateKeyToAccount(env.ownerPrivateKey, { nonceManager });
    if (getAddress(owner.address) !== getAddress(env.ownerAddress))
        throw new AppError("OWNER_KEY_MISMATCH", "OWNER_ADDRESS is not the address of OWNER_PRIVATE_KEY");
    return { agent, owner, agentAddress: getAddress(agent.address), ownerAddress: getAddress(owner.address), feeRecipient: env.feeRecipientAddress };
}

export function createKilnClient(env: CliEnv, mode: "fake" | "real"): KilnClient {
    if (mode === "fake") return new FakeKilnClient(defaultFakeHandler, env.kiln.model);
    if (!env.kiln.apiKey) throw new AppError("ENV_INVALID", "KILN_API_KEY is required for --kiln real");
    return new OpenAiKilnClient({
        apiKey: env.kiln.apiKey,
        baseURL: env.kiln.baseUrl,
        body: {
            model: env.kiln.model,
            maxTokensParse: env.kiln.maxTokensParse,
            maxTokensJudge: env.kiln.maxTokensJudge,
            thinkingMode: env.kiln.thinkingMode,
        },
    });
}

/** `import.meta.url` of the entry file vs argv[1] — true when the module is run directly with tsx. */
export function isEntry(metaUrl: string): boolean {
    const entry = process.argv[1];
    return entry !== undefined && path.resolve(entry).toLowerCase() === fileURLToPath(metaUrl).toLowerCase();
}

/** One-line JSON log (Architecture 관측성). Never pass keys, RPC_URL or env values. */
export function logLine(level: "info" | "error", event: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    (level === "error" ? console.error : console.log)(line);
}

/** Only our own messages are printed in full; library errors (which can embed request URLs) keep their first line. */
function safeMessage(err: unknown): string {
    if (err instanceof AppError) return err.message;
    const short = (err as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string") return short;
    return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

/** Runs a CLI main: any error → one error line + exit code 1. */
export function runCli(main: () => Promise<void>): void {
    main().catch((err: unknown) => {
        const code = err instanceof AppError ? err.code : "INTERNAL";
        logLine("error", "cli.failed", { code, message: safeMessage(err) });
        process.exitCode = 1;
    });
}
