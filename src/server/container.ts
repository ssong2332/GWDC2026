import "server-only";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { createPublicClient, http, type Address } from "viem";
import { NETWORKS, parseDeploymentFile, viemChain, type DeploymentFile, type NetworkName } from "@/adapters/chain/networks";
import { createViemVaultReader } from "@/adapters/chain/viemVault";
import { createChainEventRepo } from "@/adapters/db/chainEventRepo";
import { createEvidenceRepo } from "@/adapters/db/evidenceRepo";
import { createKilnCallRepo } from "@/adapters/db/kilnCallRepo";
import { openDatabase } from "@/adapters/db/sqlite";
import { createSpendRequestRepo } from "@/adapters/db/spendRequestRepo";
import { FakeKilnClient, defaultFakeHandler } from "@/adapters/kiln/fakeKilnClient";
import { OpenAiKilnClient } from "@/adapters/kiln/openaiKilnClient";
import { OWNER_CONFIRM } from "@/config/constants";
import type { ServerEnv } from "@/config/env";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import type { Hex, MerchantEntry } from "@/core/domain/types";
import { AppError } from "@/core/errors";
import type { ChainEventRepo, Clock, EvidenceRepo, KilnCallRepo, KilnClient, SpendRequestRepo, VaultReader } from "@/core/ports";
import { loadServerEnv } from "./env";

// Server composition root (Architecture 구조 개요, D-16): only key-less adapters. There is no wallet client here —
// owner transactions are signed by the browser wallet, agent transactions by the CLI.

export type AppContainer = {
    network: NetworkName;
    chainId: number;
    vault: Hex;
    token: Hex;
    owner: Hex;
    agent: Hex;
    feeBps: number;
    deployBlock: bigint;
    /** Explorer tx URL prefix, null on the local node. */
    explorerTxUrl: string | null;
    reader: VaultReader;
    evidence: EvidenceRepo;
    kilnCalls: KilnCallRepo;
    spendRequests: SpendRequestRepo;
    chainEvents: ChainEventRepo;
    kiln: KilnClient;
    merchants: MerchantEntry[];
    clock: Clock;
    confirm: { timeoutMs: number; pollMs: number };
    close(): void;
};

type ContainerOptions = {
    deployment?: DeploymentFile;
    kiln?: KilnClient;
    db?: Database.Database;
    confirm?: { timeoutMs: number; pollMs: number };
};

function createKiln(env: ServerEnv): KilnClient {
    if (env.kiln.mode === "fake") return new FakeKilnClient(defaultFakeHandler, env.kiln.model);
    if (!env.kiln.apiKey) throw new AppError("ENV_INVALID", "KILN_API_KEY is required when KILN_MODE=real");
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

/** RPC/transport failures of the reader surface as CHAIN_RPC_ERROR (502) instead of an opaque 500. */
function withRpcErrors(reader: VaultReader): VaultReader {
    const wrap =
        <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
        async (...a: A): Promise<R> => {
            try {
                return await fn(...a);
            } catch (err) {
                if (err instanceof AppError) throw err;
                throw new AppError("CHAIN_RPC_ERROR", "could not read the vault from the RPC", true, { cause: err });
            }
        };
    return {
        getState: wrap(reader.getState),
        remainingBudget: wrap(reader.remainingBudget),
        getPending: wrap(reader.getPending),
        getReceiptEvents: wrap(reader.getReceiptEvents),
        getLogs: wrap(reader.getLogs),
        latestBlock: wrap(reader.latestBlock),
    };
}

export function openServerDatabase(databasePath: string): Database.Database {
    if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    return openDatabase(databasePath);
}

export function createAppContainer(env: ServerEnv, opts: ContainerOptions = {}): AppContainer {
    const deployment = opts.deployment ?? readDeployment(env.chain);
    if (deployment.network !== env.chain)
        throw new AppError("DEPLOYMENT_INVALID", `deployment is for ${deployment.network}, CHAIN is ${env.chain}`);
    const ownsDb = opts.db === undefined;
    const db = opts.db ?? openServerDatabase(env.databasePath);
    const client = createPublicClient({ chain: viemChain(env.chain, env.rpcUrl), transport: http(env.rpcUrl) });
    return {
        network: env.chain,
        chainId: deployment.chainId,
        vault: deployment.vault,
        token: deployment.token,
        owner: deployment.owner,
        agent: deployment.agent,
        feeBps: deployment.feeBps,
        deployBlock: BigInt(deployment.deployBlock),
        explorerTxUrl: NETWORKS[env.chain].explorerTxUrl,
        reader: withRpcErrors(createViemVaultReader({ client, vault: deployment.vault as Address, chainId: deployment.chainId })),
        evidence: createEvidenceRepo(db),
        kilnCalls: createKilnCallRepo(db),
        spendRequests: createSpendRequestRepo(db),
        chainEvents: createChainEventRepo(db),
        kiln: opts.kiln ?? createKiln(env),
        merchants: MERCHANT_REGISTRY,
        clock: { now: () => new Date() },
        confirm: opts.confirm ?? OWNER_CONFIRM,
        close: () => {
            if (ownsDb) db.close();
        },
    };
}

function deploymentPath(network: NetworkName): string {
    return path.resolve(/*turbopackIgnore: true*/ process.cwd(), NETWORKS[network].deploymentFile);
}

function readDeploymentText(network: NetworkName): string {
    const file = deploymentPath(network);
    if (!fs.existsSync(file)) throw new AppError("DEPLOYMENT_NOT_FOUND", `no deployment file for ${network} — deploy first`);
    return fs.readFileSync(file, "utf8");
}

function readDeployment(network: NetworkName): DeploymentFile {
    return parseDeploymentFile(JSON.parse(readDeploymentText(network)));
}

// One container per server process (kept on globalThis so dev hot reloads reuse it). The deployment file is re-read on
// every request: a redeploy (e.g. `npm run e2e:local`) switches the vault without a server restart. The database stays open.
type Cache = { env: ServerEnv; db: Database.Database; deploymentText: string; container: AppContainer };
const holder = globalThis as unknown as { __appContainer?: Cache };

/** Loads the server env on first use — refuses to run if a private key is in the server environment (ADR-0005, D-16). */
export function getContainer(): AppContainer {
    const env = holder.__appContainer?.env ?? loadServerEnv();
    const text = readDeploymentText(env.chain);
    const cached = holder.__appContainer;
    if (cached && cached.deploymentText === text) return cached.container;
    const deployment = parseDeploymentFile(JSON.parse(text));
    const db = cached?.db ?? openServerDatabase(env.databasePath);
    const container = createAppContainer(env, { deployment, db });
    holder.__appContainer = { env, db, deploymentText: text, container };
    return container;
}
