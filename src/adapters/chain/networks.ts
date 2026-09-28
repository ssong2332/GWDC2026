import fs from "node:fs";
import path from "node:path";
import { getAddress, type Chain } from "viem";
import { baseSepolia, hardhat } from "viem/chains";
import { z } from "zod";
import type { Hex } from "@/core/domain/types";
import { AppError } from "@/core/errors";

// Networks and deployment files (Architecture 7 "배포 파일·네트워크", D-30). Deployment addresses are files,
// not env: deployments/baseSepolia.json (committed) and data.local/deployments/localhost.json (local only).

export type NetworkName = "localhost" | "baseSepolia";

export type DeploymentFile = {
    network: NetworkName;
    chainId: number;
    token: Hex;
    vault: Hex;
    owner: Hex;
    agent: Hex;
    feeRecipient: Hex;
    feeBps: number;
    vaultMint: string;
    deployBlock: number;
};

export const NETWORKS = {
    localhost: { chainId: 31337, deploymentFile: "data.local/deployments/localhost.json", explorerTxUrl: null },
    baseSepolia: { chainId: 84532, deploymentFile: "deployments/baseSepolia.json", explorerTxUrl: "https://sepolia.basescan.org/tx/" },
} as const satisfies Record<NetworkName, { chainId: 31337 | 84532; deploymentFile: string; explorerTxUrl: string | null }>;

export function explorerTxUrl(network: NetworkName, txHash: Hex): string | null {
    const base = NETWORKS[network].explorerTxUrl;
    return base === null ? null : `${base}${txHash}`;
}

/** viem chain object for the network with RPC_URL as its RPC. */
export function viemChain(network: NetworkName, rpcUrl: string): Chain {
    const base = network === "localhost" ? hardhat : baseSepolia;
    return { ...base, rpcUrls: { default: { http: [rpcUrl] } } } as Chain;
}

const address = z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((a) => getAddress(a) as Hex);

const deploymentSchema = z
    .object({
        network: z.enum(["localhost", "baseSepolia"]),
        chainId: z.number().int(),
        token: address,
        vault: address,
        owner: address,
        agent: address,
        feeRecipient: address,
        feeBps: z.number().int().min(0),
        vaultMint: z.string().regex(/^\d+$/),
        deployBlock: z.number().int().min(0),
    })
    .refine((d) => d.chainId === NETWORKS[d.network].chainId, { message: "chainId does not match network", path: ["chainId"] });

export function parseDeploymentFile(json: unknown): DeploymentFile {
    const r = deploymentSchema.safeParse(json);
    if (!r.success) {
        const i = r.error.issues[0];
        throw new AppError("DEPLOYMENT_INVALID", `deployment file ${i.path.join(".") || "root"}: ${i.message}`);
    }
    return r.data;
}

export function readDeploymentFile(file: string): DeploymentFile {
    if (!fs.existsSync(file)) throw new AppError("DEPLOYMENT_NOT_FOUND", `no deployment file at ${file} — deploy first`);
    return parseDeploymentFile(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function writeDeploymentFile(file: string, dep: DeploymentFile): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(dep, null, 2)}\n`, "utf8");
}
