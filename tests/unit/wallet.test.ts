import {
    ChainMismatchError,
    ContractFunctionExecutionError,
    ContractFunctionRevertedError,
    UserRejectedRequestError,
    encodeErrorResult,
} from "viem";
import { baseSepolia, hardhat } from "viem/chains";
import { describe, expect, it } from "vitest";
import { policyVaultAbi } from "@/adapters/chain/generated/PolicyVault";
import { connectWallet, readWallet, switchWalletChain, type Eip1193Provider } from "@/ui/wallet/eip1193";
import { chainFor, chainLabel } from "@/ui/wallet/chains";
import { describeWalletError, toContractCall } from "@/ui/wallet/contractCall";
import { evaluateGate, type WalletSnapshot } from "@/ui/wallet/gate";

// Browser wallet logic (Architecture 10 지갑 상태·권한·네트워크 가드·서명 흐름, D-15 — viem custom(window.ethereum), no wagmi).

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const HASH = `0x${"11".repeat(32)}` as const;

type Call = { method: string; params?: unknown[] };

/** Scriptable EIP-1193 provider: answers by method, records every call. */
function fakeProvider(answers: Record<string, (params?: unknown[]) => unknown>): Eip1193Provider & { calls: Call[] } {
    const calls: Call[] = [];
    return {
        calls,
        async request(args: Call) {
            calls.push(args);
            const fn = answers[args.method];
            if (!fn) throw Object.assign(new Error(`unsupported ${args.method}`), { code: 4200 });
            return fn(args.params);
        },
    };
}

describe("readWallet / connectWallet (WalletProvider state: no_wallet · disconnected · connected)", () => {
    it("no provider → no_wallet", async () => {
        expect(await readWallet(null)).toEqual({ status: "no_wallet", address: null, chainId: null });
    });

    it("provider without authorised accounts → disconnected (chain still known)", async () => {
        const p = fakeProvider({ eth_accounts: () => [], eth_chainId: () => "0x14a34" });
        expect(await readWallet(p)).toEqual({ status: "disconnected", address: null, chainId: 84532 });
    });

    it("authorised account → connected with a checksummed address and numeric chain id", async () => {
        const p = fakeProvider({ eth_accounts: () => [OWNER.toLowerCase()], eth_chainId: () => "0x7a69" });
        expect(await readWallet(p)).toEqual({ status: "connected", address: OWNER, chainId: 31337 });
    });

    it("connectWallet asks with eth_requestAccounts", async () => {
        const p = fakeProvider({ eth_requestAccounts: () => [OWNER], eth_chainId: () => "0x7a69" });
        expect(await connectWallet(p)).toEqual({ status: "connected", address: OWNER, chainId: 31337 });
        expect(p.calls[0].method).toBe("eth_requestAccounts");
    });

    it("connectWallet rejected by the user throws the provider error (4001)", async () => {
        const p = fakeProvider({
            eth_requestAccounts: () => {
                throw Object.assign(new Error("User rejected"), { code: 4001 });
            },
        });
        await expect(connectWallet(p)).rejects.toMatchObject({ code: 4001 });
    });
});

describe("switchWalletChain — wallet_switchEthereumChain, falling back to wallet_addEthereumChain", () => {
    it("switches directly when the wallet knows the chain", async () => {
        const p = fakeProvider({ wallet_switchEthereumChain: () => null });
        await switchWalletChain(p, 84532);
        expect(p.calls).toEqual([{ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] }]);
    });

    it("unknown chain (4902) → adds Base Sepolia with its public RPC and explorer", async () => {
        let first = true;
        const p = fakeProvider({
            wallet_switchEthereumChain: () => {
                if (first) {
                    first = false;
                    throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
                }
                return null;
            },
            wallet_addEthereumChain: () => null,
        });
        await switchWalletChain(p, 84532);
        expect(p.calls.map((c) => c.method)).toEqual(["wallet_switchEthereumChain", "wallet_addEthereumChain"]);
        const added = (p.calls[1].params as Record<string, unknown>[])[0];
        expect(added).toMatchObject({ chainId: "0x14a34", chainName: "Base Sepolia" });
        expect(added.rpcUrls).toEqual(["https://sepolia.base.org"]);
        expect(added.blockExplorerUrls).toEqual(["https://sepolia.basescan.org"]);
    });

    it("a rejected switch (4001) is not turned into an add", async () => {
        const p = fakeProvider({
            wallet_switchEthereumChain: () => {
                throw Object.assign(new Error("rejected"), { code: 4001 });
            },
            wallet_addEthereumChain: () => null,
        });
        await expect(switchWalletChain(p, 84532)).rejects.toMatchObject({ code: 4001 });
        expect(p.calls).toHaveLength(1);
    });

    it("an unsupported target chain id throws WRONG_NETWORK without calling the wallet", async () => {
        const p = fakeProvider({});
        await expect(switchWalletChain(p, 1)).rejects.toMatchObject({ code: "WRONG_NETWORK" });
        expect(p.calls).toHaveLength(0);
    });
});

describe("chains", () => {
    it("only the two project chains are known", () => {
        expect(chainFor(31337)?.id).toBe(hardhat.id);
        expect(chainFor(84532)?.id).toBe(baseSepolia.id);
        expect(chainFor(1)).toBeNull();
        expect(chainLabel(84532)).toBe("Base Sepolia");
        expect(chainLabel(31337)).toBe("Hardhat local (31337)");
        expect(chainLabel(5)).toBe("chain 5");
    });
});

describe("evaluateGate (WalletGate: owner + server chain only)", () => {
    const target = { owner: OWNER, chainId: 84532 };
    const w = (over: Partial<WalletSnapshot>): WalletSnapshot => ({ status: "connected", address: OWNER, chainId: 84532, ...over });

    it("owner on the server's chain → allowed", () => {
        expect(evaluateGate(w({}), target)).toEqual({ allowed: true });
    });

    it("owner address compared case-insensitively", () => {
        expect(evaluateGate(w({ address: OWNER.toLowerCase() as `0x${string}` }), target)).toEqual({ allowed: true });
    });

    it.each([
        ["no_wallet", w({ status: "no_wallet", address: null, chainId: null })],
        ["disconnected", w({ status: "disconnected", address: null })],
        ["wrong_chain", w({ chainId: 31337 })],
        ["not_owner", w({ address: OTHER })],
    ] as const)("%s", (reason, wallet) => {
        expect(evaluateGate(wallet, target)).toEqual({ allowed: false, reason });
    });

    it("wrong chain is reported before not-owner (switch first, then the owner check is meaningful)", () => {
        expect(evaluateGate(w({ address: OTHER, chainId: 1 }), target)).toEqual({ allowed: false, reason: "wrong_chain" });
    });

    it("vault state not loaded yet → loading, never allowed", () => {
        expect(evaluateGate(w({}), null)).toEqual({ allowed: false, reason: "loading" });
    });
});

describe("toContractCall — API call DTO (bigint as decimal strings) → viem args", () => {
    it("setPolicy restores bigints in the PolicyInput struct", () => {
        const c = toContractCall({
            functionName: "setPolicy",
            args: [
                { budget: "200000", approvalThreshold: "50000", expiresAt: "1900000000", maxPerMinute: 3, maxPerDay: 20, merchants: [OWNER] },
                HASH,
            ],
        });
        expect(c).toEqual({
            functionName: "setPolicy",
            args: [{ budget: 200_000n, approvalThreshold: 50_000n, expiresAt: 1_900_000_000n, maxPerMinute: 3, maxPerDay: 20, merchants: [OWNER] }, HASH],
        });
    });

    it("approve / reject / pause pass hex arguments through", () => {
        expect(toContractCall({ functionName: "approve", args: [HASH, HASH] })).toEqual({ functionName: "approve", args: [HASH, HASH] });
        expect(toContractCall({ functionName: "reject", args: [HASH, HASH] })).toEqual({ functionName: "reject", args: [HASH, HASH] });
        expect(toContractCall({ functionName: "pause", args: [HASH] })).toEqual({ functionName: "pause", args: [HASH] });
    });

    it.each([
        ["an unexpected function", { functionName: "spend", args: [] }],
        ["unpause (not a UI action)", { functionName: "unpause", args: [HASH] }],
        ["a malformed hash", { functionName: "pause", args: ["0x12"] }],
        ["a wrong arg count", { functionName: "approve", args: [HASH] }],
        ["a non-numeric amount", { functionName: "setPolicy", args: [{ budget: "abc", approvalThreshold: "1", expiresAt: "1", maxPerMinute: 1, maxPerDay: 1, merchants: [] }, HASH] }],
    ])("rejects %s with BAD_RESPONSE", (_n, dto) => {
        expect(() => toContractCall(dto as never)).toThrow(expect.objectContaining({ code: "BAD_RESPONSE" }));
    });
});

describe("describeWalletError — wallet / contract errors → UI codes", () => {
    const reverted = (errorName: string, args?: unknown[]) =>
        new ContractFunctionExecutionError(
            new ContractFunctionRevertedError({
                abi: policyVaultAbi,
                functionName: "approve",
                data: encodeErrorResult({ abi: policyVaultAbi, errorName, args } as never),
            }),
            { abi: policyVaultAbi, functionName: "approve", contractAddress: OWNER, args: [] },
        );

    it("user rejection (viem UserRejectedRequestError) → SIGNATURE_REJECTED", () => {
        expect(describeWalletError(new UserRejectedRequestError(new Error("denied"))).code).toBe("SIGNATURE_REJECTED");
    });

    it("raw EIP-1193 error object with code 4001 → SIGNATURE_REJECTED", () => {
        expect(describeWalletError({ code: 4001, message: "User denied" }).code).toBe("SIGNATURE_REJECTED");
    });

    it.each([
        ["NotOwner", "CONTRACT_NOT_OWNER"],
        ["PendingExists", "CONTRACT_PENDING_EXISTS"],
        ["PendingNotFound", "CONTRACT_PENDING_NOT_FOUND"],
        ["VaultIsPaused", "CONTRACT_VAULT_IS_PAUSED"],
        ["PolicyExpired", "CONTRACT_POLICY_EXPIRED"],
        ["AlreadyPaused", "CONTRACT_ALREADY_PAUSED"],
    ])("custom error %s → %s (readable before signing)", (name, code) => {
        expect(describeWalletError(reverted(name)).code).toBe(code);
    });

    it("InvalidPolicy(field) names the field", () => {
        const e = describeWalletError(reverted("InvalidPolicy", [3]));
        expect(e.code).toBe("CONTRACT_INVALID_POLICY");
        expect(e.message).toContain("expiresAt");
    });

    it("chain mismatch → WRONG_NETWORK", () => {
        expect(describeWalletError(new ChainMismatchError({ chain: baseSepolia, currentChainId: 1 })).code).toBe("WRONG_NETWORK");
    });

    it("anything else → WALLET_ERROR with a one-line message", () => {
        const e = describeWalletError(new Error("line one\nline two with https://rpc.example/KEY"));
        expect(e.code).toBe("WALLET_ERROR");
        expect(e.message).toBe("line one");
        expect(describeWalletError("weird").code).toBe("WALLET_ERROR");
    });
});
