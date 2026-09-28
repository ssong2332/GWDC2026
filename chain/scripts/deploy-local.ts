import fs from "node:fs";
import path from "node:path";
import hre from "hardhat";
import { getAddress, type Address } from "viem";

// Values of E2E step 0 (Architecture "E2E 시나리오"): 1% fee (D-06), vault funded with 1,000,000 mKRW.
export const LOCAL_FEE_BPS = 100;
export const LOCAL_VAULT_MINT = 1_000_000n;

export const DEFAULT_DEPLOYMENT_FILE = path.resolve(__dirname, "../../data.local/deployments/localhost.json");

export interface LocalDeployment {
    network: "localhost";
    chainId: number;
    token: Address;
    vault: Address;
    owner: Address;
    agent: Address;
    feeRecipient: Address;
    feeBps: number;
    vaultMint: string;
    deployBlock: number;
}

// Uses the node's own unlocked accounts (#0 deployer = agent, #1 owner, #2 fee recipient) — no keys in code.
export async function deployLocal(): Promise<LocalDeployment> {
    const [agent, owner, feeRecipient] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();

    const token = await hre.viem.deployContract("MockKRWT");
    const { contract: vault, deploymentTransaction } = await hre.viem.sendDeploymentTransaction("PolicyVault", [
        token.address,
        owner.account.address,
        agent.account.address,
        feeRecipient.account.address,
        LOCAL_FEE_BPS,
    ]);
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
    const mintHash = await token.write.mint([vault.address, LOCAL_VAULT_MINT]);
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    return {
        network: "localhost",
        chainId: await publicClient.getChainId(),
        token: getAddress(token.address),
        vault: getAddress(vault.address),
        owner: getAddress(owner.account.address),
        agent: getAddress(agent.account.address),
        feeRecipient: getAddress(feeRecipient.account.address),
        feeBps: LOCAL_FEE_BPS,
        vaultMint: LOCAL_VAULT_MINT.toString(),
        deployBlock: Number(deployReceipt.blockNumber),
    };
}

export function writeDeployment(dep: LocalDeployment, file: string = DEFAULT_DEPLOYMENT_FILE): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(dep, null, 2)}\n`, "utf8");
}

if (require.main === module) {
    deployLocal()
        .then((dep) => {
            writeDeployment(dep);
            console.log(JSON.stringify(dep, null, 2));
            console.log(`written ${path.relative(process.cwd(), DEFAULT_DEPLOYMENT_FILE)}`);
        })
        .catch((err) => {
            console.error(err);
            process.exitCode = 1;
        });
}
