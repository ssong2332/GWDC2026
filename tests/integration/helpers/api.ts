import { createPublicClient, getAddress, http, type Address } from "viem";
import { hardhat } from "viem/chains";
import {
    handleAudit,
    handleConfirmOwnerAction,
    handleEfficiency,
    handleParsePolicy,
    handlePrepareOwnerAction,
    handleReceipt,
    handleVaultActivity,
    handleVaultState,
} from "@/app/api/_lib/handlers";
import type { DeploymentFile } from "@/adapters/chain/networks";
import type { AppContainer } from "@/server/container";
import type { Eip1193Provider } from "@/ui/wallet/eip1193";
import type { Deployed } from "./chain";
import { INTEGRATION_RPC_URL } from "./rpc";

// Test-only glue: the Route Handlers served in-process (same functions the route.ts files call), and an EIP-1193
// provider standing in for the browser wallet (the Hardhat node signs for its unlocked accounts, like a wallet would).

export function deploymentOf(d: Deployed): DeploymentFile {
    return {
        network: "localhost",
        chainId: hardhat.id,
        token: getAddress(d.token),
        vault: getAddress(d.vault),
        owner: getAddress(d.owner),
        agent: getAddress(d.agent),
        feeRecipient: getAddress(d.feeRecipient),
        feeBps: 100,
        vaultMint: "1000000",
        deployBlock: Number(d.deployBlock),
    };
}

export function apiFetch(c: AppContainer): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input), "http://127.0.0.1:3000");
        const req = new Request(url, init);
        const route = `${req.method} ${url.pathname}`;
        if (route === "POST /api/policy/parse") return handleParsePolicy(c, req);
        if (route === "POST /api/owner-actions/prepare") return handlePrepareOwnerAction(c, req);
        if (route === "POST /api/owner-actions/confirm") return handleConfirmOwnerAction(c, req);
        if (route === "GET /api/vault/state") return handleVaultState(c);
        if (route === "GET /api/vault/activity") return handleVaultActivity(c);
        const receipt = /^GET \/api\/receipts\/([^/]+)$/.exec(route);
        if (receipt) return handleReceipt(c, decodeURIComponent(receipt[1]));
        const audit = /^GET \/api\/audit\/([^/]+)$/.exec(route);
        if (audit) return handleAudit(c, decodeURIComponent(audit[1]));
        if (route === "GET /api/efficiency") return handleEfficiency(c);
        return new Response("no route", { status: 404 });
    }) as typeof fetch;
}

type Rpc = { method: string; params?: unknown[] };

/** A wallet with exactly one connected account. `refuse` makes the named methods fail like a user rejection (4001). */
export function walletShim(account: Address, opts: { refuse?: string[] } = {}): Eip1193Provider & { sent: Rpc[] } {
    const node = createPublicClient({ chain: hardhat, transport: http(INTEGRATION_RPC_URL) });
    const sent: Rpc[] = [];
    return {
        sent,
        async request(args: Rpc) {
            sent.push(args);
            if (opts.refuse?.includes(args.method)) throw Object.assign(new Error("User denied transaction signature."), { code: 4001 });
            if (args.method === "eth_accounts" || args.method === "eth_requestAccounts") return [account];
            return node.request(args as never);
        },
    };
}
