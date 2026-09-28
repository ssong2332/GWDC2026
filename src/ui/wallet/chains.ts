import type { Chain } from "viem";
import { baseSepolia, hardhat } from "viem/chains";

// The two chains this project runs on (Architecture 기술 스택 배포: Hardhat 31337 for development, Base Sepolia 84532).

const CHAINS: Record<number, { chain: Chain; label: string }> = {
    [hardhat.id]: { chain: hardhat, label: "Hardhat local (31337)" },
    [baseSepolia.id]: { chain: baseSepolia, label: "Base Sepolia" },
};

export function chainFor(chainId: number): Chain | null {
    return CHAINS[chainId]?.chain ?? null;
}

export function chainLabel(chainId: number): string {
    return CHAINS[chainId]?.label ?? `chain ${chainId}`;
}

/** wallet_addEthereumChain parameters (EIP-3085). */
export function addChainParams(chain: Chain) {
    return {
        chainId: `0x${chain.id.toString(16)}`,
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: [...chain.rpcUrls.default.http],
        blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
    };
}
