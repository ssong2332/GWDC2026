import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAddress } from "viem";
import { hardhat } from "viem/chains";
import { describe, expect, it } from "vitest";
import { mockKrwtAbi } from "@/adapters/chain/generated/MockKRWT";
import { policyVaultAbi } from "@/adapters/chain/generated/PolicyVault";
import { readDeploymentFile, writeDeploymentFile } from "@/adapters/chain/networks";
import { deployContracts } from "../../cli/deploy";
import { accounts, publicClient, walletClient } from "./helpers/chain";

// cli/deploy.ts (D-30) replaces chain/scripts/deploy-local.ts: the same step-0 values, via viem + generated artifacts.

describe("deployContracts (cli/deploy.ts)", () => {
    it("deploys MockKRWT + PolicyVault (deployer = agent), funds the vault and returns the DeploymentFile", async () => {
        const { agent, owner, feeRecipient } = await accounts();
        const before = await publicClient.getBlockNumber();

        const { deployment, txs } = await deployContracts({ network: "localhost", publicClient, walletClient, chain: hardhat, deployer: agent, owner, feeRecipient });

        expect(deployment).toMatchObject({
            network: "localhost",
            chainId: 31337,
            owner: getAddress(owner),
            agent: getAddress(agent),
            feeRecipient: getAddress(feeRecipient),
            feeBps: 100,
            vaultMint: "1000000",
        });
        expect(BigInt(deployment.deployBlock) > before).toBe(true);
        const read = <T>(fn: string) => publicClient.readContract({ address: deployment.vault, abi: policyVaultAbi, functionName: fn } as never) as Promise<T>;
        expect(getAddress(await read<string>("owner"))).toBe(deployment.owner);
        expect(getAddress(await read<string>("agent"))).toBe(deployment.agent);
        expect(getAddress(await read<string>("token"))).toBe(deployment.token);
        expect(await read<number>("feeBps")).toBe(100);
        expect(await publicClient.readContract({ address: deployment.token, abi: mockKrwtAbi, functionName: "balanceOf", args: [deployment.vault] })).toBe(1_000_000n);
        // token deploy, vault deploy, mint — all paid by the deployer (E2E ETH totals)
        expect(txs.map((t) => t.label)).toEqual(["deploy MockKRWT", "deploy PolicyVault", "mint vault"]);
        for (const t of txs) expect(t.feeWei > 0n && t.gasUsed > 0n).toBe(true);
    });

    it("a zero-fee deployment with a custom mint (boundaries accepted by the constructor)", async () => {
        const { agent, owner, feeRecipient } = await accounts();
        const { deployment } = await deployContracts({ network: "localhost", publicClient, walletClient, chain: hardhat, deployer: agent, owner, feeRecipient, feeBps: 0, mint: 1n });
        expect(deployment).toMatchObject({ feeBps: 0, vaultMint: "1" });
    });

    it("an owner equal to the zero address is rejected by the contract (ZeroAddress) and nothing is returned", async () => {
        const { agent, feeRecipient } = await accounts();
        await expect(
            deployContracts({ network: "localhost", publicClient, walletClient, chain: hardhat, deployer: agent, owner: "0x0000000000000000000000000000000000000000", feeRecipient }),
        ).rejects.toThrow();
    });

    it("the deployment file round-trips through write/read (creating the directory)", async () => {
        const { agent, owner, feeRecipient } = await accounts();
        const { deployment } = await deployContracts({ network: "localhost", publicClient, walletClient, chain: hardhat, deployer: agent, owner, feeRecipient });
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deploy-")), "deployments", "localhost.json");
        writeDeploymentFile(file, deployment);
        expect(readDeploymentFile(file)).toEqual(deployment);
        expect(() => readDeploymentFile(path.join(path.dirname(file), "missing.json"))).toThrow(/deploy first/);
    });
});
