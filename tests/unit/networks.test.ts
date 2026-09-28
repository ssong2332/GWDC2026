import { describe, expect, it } from "vitest";
import { NETWORKS, explorerTxUrl, parseDeploymentFile, viemChain } from "@/adapters/chain/networks";
import { AppError } from "@/core/errors";

const valid = {
    network: "localhost",
    chainId: 31337,
    token: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    vault: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    agent: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    feeRecipient: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    feeBps: 100,
    vaultMint: "1000000",
    deployBlock: 2,
};

describe("NETWORKS (Architecture 7 배포 파일·네트워크)", () => {
    it("fixes chain ids, deployment files and explorer URLs", () => {
        expect(NETWORKS).toEqual({
            localhost: { chainId: 31337, deploymentFile: "data.local/deployments/localhost.json", explorerTxUrl: null },
            baseSepolia: { chainId: 84532, deploymentFile: "deployments/baseSepolia.json", explorerTxUrl: "https://sepolia.basescan.org/tx/" },
        });
    });

    it("explorer link only exists for Base Sepolia", () => {
        const tx = `0x${"ab".repeat(32)}` as const;
        expect(explorerTxUrl("baseSepolia", tx)).toBe(`https://sepolia.basescan.org/tx/${tx}`);
        expect(explorerTxUrl("localhost", tx)).toBeNull();
    });

    it("viem chain objects keep the chain id and use RPC_URL", () => {
        const c = viemChain("baseSepolia", "https://rpc.example.test");
        expect(c.id).toBe(84532);
        expect(c.rpcUrls.default.http).toEqual(["https://rpc.example.test"]);
        expect(viemChain("localhost", "http://127.0.0.1:8545").id).toBe(31337);
    });
});

describe("parseDeploymentFile", () => {
    it("accepts the T-02 LocalDeployment shape and checksums addresses", () => {
        const d = parseDeploymentFile(valid);
        expect(d.token).toBe("0x5FbDB2315678afecb367f032d93F642f64180aa3");
        expect(d).toMatchObject({ network: "localhost", chainId: 31337, feeBps: 100, vaultMint: "1000000", deployBlock: 2 });
    });

    it("accepts deployBlock 0 (boundary)", () => {
        expect(parseDeploymentFile({ ...valid, deployBlock: 0 }).deployBlock).toBe(0);
    });

    it.each<[string, Record<string, unknown>]>([
        ["a chain id that does not match the network", { chainId: 84532 }],
        ["an unknown network", { network: "mainnet" }],
        ["a malformed vault address", { vault: "0x1234" }],
        ["a non-decimal mint", { vaultMint: "1e6" }],
        ["a negative deploy block", { deployBlock: -1 }],
    ])("rejects %s with DEPLOYMENT_INVALID", (_label, over) => {
        let caught: unknown;
        try {
            parseDeploymentFile({ ...valid, ...over });
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(AppError);
        expect((caught as AppError).code).toBe("DEPLOYMENT_INVALID");
    });
});
