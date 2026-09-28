import path from "node:path";
import { parseArgs } from "node:util";
import { getAddress, type Account, type Address, type Chain, type PublicClient, type WalletClient } from "viem";
import { mockKrwtAbi, mockKrwtBytecode } from "@/adapters/chain/generated/MockKRWT";
import { policyVaultAbi, policyVaultBytecode } from "@/adapters/chain/generated/PolicyVault";
import { NETWORKS, explorerTxUrl, writeDeploymentFile, type DeploymentFile, type NetworkName } from "@/adapters/chain/networks";
import { withReadRetry } from "@/adapters/chain/readRetry";
import { DEPLOY_DEFAULTS } from "@/config/constants";
import type { Hex } from "@/core/domain/types";
import { AppError } from "@/core/errors";
import { loadCliEnv } from "./_env";
import { assertRpcChain, createClients, isEntry, logLine, resolveSigners, runCli } from "./_container";

// Deploy MockKRWT + PolicyVault and fund the vault (E2E step 0). Single deploy path for both networks (D-30):
//   npx tsx cli/deploy.ts --chain localhost|baseSepolia [--rpc <url>]

export type DeployTx = { label: string; txHash: Hex; gasUsed: bigint; feeWei: bigint };

type DeployArgs = {
    network: NetworkName;
    publicClient: PublicClient;
    walletClient: WalletClient;
    chain: Chain;
    /** Deployer and agent (D-25: the agent key pays for deployment). */
    deployer: Account | Address;
    owner: Hex;
    feeRecipient: Hex;
    feeBps?: number;
    mint?: bigint;
};

export async function deployContracts(a: DeployArgs): Promise<{ deployment: DeploymentFile; txs: DeployTx[] }> {
    const feeBps = a.feeBps ?? DEPLOY_DEFAULTS.feeBps;
    const mint = a.mint ?? DEPLOY_DEFAULTS.vaultMint;
    const agent = getAddress(typeof a.deployer === "string" ? a.deployer : a.deployer.address);
    const txs: DeployTx[] = [];

    const confirm = async (label: string, hash: Hex) => {
        // Read-only wait (T-07 retry on lagging RPC nodes); the deploy transaction itself is never re-sent.
        const r = await withReadRetry(() => a.publicClient.waitForTransactionReceipt({ hash }));
        if (r.status !== "success") throw new AppError("CHAIN_TX_REVERTED", `${label} reverted (${hash})`);
        const l1Fee = (r as { l1Fee?: bigint | null }).l1Fee ?? 0n;
        txs.push({ label, txHash: hash, gasUsed: r.gasUsed, feeWei: r.gasUsed * r.effectiveGasPrice + l1Fee });
        return r;
    };
    const send = { account: a.deployer, chain: a.chain } as const;

    const token = await confirm("deploy MockKRWT", await a.walletClient.deployContract({ abi: mockKrwtAbi, bytecode: mockKrwtBytecode, args: [], ...send } as never));
    if (!token.contractAddress) throw new AppError("CHAIN_TX_REVERTED", "MockKRWT deployment has no contract address");
    const vaultArgs = [token.contractAddress, a.owner, agent, a.feeRecipient, feeBps];
    const vault = await confirm("deploy PolicyVault", await a.walletClient.deployContract({ abi: policyVaultAbi, bytecode: policyVaultBytecode, args: vaultArgs, ...send } as never));
    if (!vault.contractAddress) throw new AppError("CHAIN_TX_REVERTED", "PolicyVault deployment has no contract address");
    await confirm(
        "mint vault",
        await a.walletClient.writeContract({ address: token.contractAddress, abi: mockKrwtAbi, functionName: "mint", args: [vault.contractAddress, mint], ...send } as never),
    );

    return {
        deployment: {
            network: a.network,
            chainId: NETWORKS[a.network].chainId,
            token: getAddress(token.contractAddress),
            vault: getAddress(vault.contractAddress),
            owner: getAddress(a.owner),
            agent,
            feeRecipient: getAddress(a.feeRecipient),
            feeBps,
            vaultMint: mint.toString(),
            deployBlock: Number(vault.blockNumber),
        },
        txs,
    };
}

export function parseNetwork(value: string | undefined, fallback: NetworkName): NetworkName {
    const v = value ?? fallback;
    if (v !== "localhost" && v !== "baseSepolia") throw new AppError("VALIDATION_FAILED", `--chain must be localhost or baseSepolia, got ${v}`);
    return v;
}

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { chain: { type: "string" }, rpc: { type: "string" } } });
    const env = loadCliEnv({ overrides: { CHAIN: values.chain, RPC_URL: values.rpc } });
    const network = parseNetwork(values.chain, env.chain);
    const { chain, publicClient, walletClient } = createClients(network, env.rpcUrl);
    await assertRpcChain(publicClient, network);
    const signers = await resolveSigners(network, env, walletClient);

    const { deployment, txs } = await deployContracts({
        network,
        publicClient,
        walletClient,
        chain,
        deployer: signers.agent,
        owner: signers.ownerAddress,
        feeRecipient: signers.feeRecipient,
    });
    const file = path.resolve(NETWORKS[network].deploymentFile);
    writeDeploymentFile(file, deployment);
    for (const t of txs) logLine("info", "deploy.tx", { ...t, explorerUrl: explorerTxUrl(network, t.txHash) });
    logLine("info", "deploy.done", { ...deployment, file: path.relative(process.cwd(), file) });
}

if (isEntry(import.meta.url)) runCli(main);
