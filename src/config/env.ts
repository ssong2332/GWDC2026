import { getAddress } from "viem";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { ENV_DEFAULTS, KILN } from "./constants";

// Pure env schema and parse functions (ADR-0005): no `server-only`, nothing read from process.env on import.
// The server (src/server/env.ts) and the CLI (cli/_env.ts) pass their own source object in.

export type EnvSource = Record<string, string | undefined>;

export type ServerEnv = {
    chain: "localhost" | "baseSepolia";
    rpcUrl: string;
    databasePath: string;
    kiln: {
        mode: "fake" | "real";
        apiKey: string | null;
        baseUrl: string;
        model: string;
        thinkingMode: "default" | "kwargs_off" | "no_think";
        maxTokensParse: number;
        maxTokensJudge: number;
    };
};

export type CliEnv = ServerEnv & {
    agentPrivateKey: `0x${string}` | null;
    ownerPrivateKey: `0x${string}` | null;
    ownerAddress: `0x${string}` | null;
    feeRecipientAddress: `0x${string}` | null;
};

const maxTokens = (fallback: number) => z.coerce.number().int().min(KILN.minMaxTokens).default(fallback);

export const serverEnvSchema = z
    .object({
        CHAIN: z.enum(["localhost", "baseSepolia"]).default("localhost"),
        RPC_URL: z.url().default(ENV_DEFAULTS.rpcUrl),
        DATABASE_PATH: z.string().min(1).default(ENV_DEFAULTS.databasePath),
        KILN_MODE: z.enum(["fake", "real"]).default("fake"),
        KILN_API_KEY: z.string().min(1).optional(),
        KILN_BASE_URL: z.url().default(ENV_DEFAULTS.kilnBaseUrl),
        KILN_MODEL: z.string().min(1).default(KILN.defaultModel),
        KILN_THINKING_MODE: z.enum(["default", "kwargs_off", "no_think"]).default("default"),
        KILN_MAX_TOKENS_PARSE: maxTokens(KILN.defaultMaxTokensParse),
        KILN_MAX_TOKENS_JUDGE: maxTokens(KILN.defaultMaxTokensJudge),
    })
    .refine((e) => e.KILN_MODE === "fake" || e.KILN_API_KEY !== undefined, {
        message: "required when KILN_MODE=real",
        path: ["KILN_API_KEY"],
    });

const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x + 64 hex characters");
const address = z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address")
    .transform((a) => getAddress(a));
const WALLET_VARS = ["AGENT_PRIVATE_KEY", "OWNER_PRIVATE_KEY", "OWNER_ADDRESS", "FEE_RECIPIENT_ADDRESS"] as const;

const walletSchema = z
    .object({
        AGENT_PRIVATE_KEY: privateKey.optional(),
        OWNER_PRIVATE_KEY: privateKey.optional(),
        OWNER_ADDRESS: address.optional(),
        FEE_RECIPIENT_ADDRESS: address.optional(),
    })
    .superRefine((w, ctx) => {
        for (const name of WALLET_VARS)
            if (w[name] === undefined) ctx.addIssue({ code: "custom", message: "required when CHAIN=baseSepolia", path: [name] });
    });

/** Empty values (`KEY=` lines) count as unset. */
function withoutEmpty(src: EnvSource): EnvSource {
    return Object.fromEntries(Object.entries(src).filter(([, v]) => v !== undefined && v !== ""));
}

/** Names the failing variables only — values (possibly secrets) never go into the message. */
function envError(issues: readonly z.core.$ZodIssue[]): Error {
    const parts = issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`);
    return new AppError("ENV_INVALID", `invalid environment — ${parts.join("; ")}`);
}

export function parseServerEnv(src: EnvSource): ServerEnv {
    const r = serverEnvSchema.safeParse(withoutEmpty(src));
    if (!r.success) throw envError(r.error.issues);
    const e = r.data;
    return {
        chain: e.CHAIN,
        rpcUrl: e.RPC_URL,
        databasePath: e.DATABASE_PATH,
        kiln: {
            mode: e.KILN_MODE,
            apiKey: e.KILN_API_KEY ?? null,
            baseUrl: e.KILN_BASE_URL,
            model: e.KILN_MODEL,
            thinkingMode: e.KILN_THINKING_MODE,
            maxTokensParse: e.KILN_MAX_TOKENS_PARSE,
            maxTokensJudge: e.KILN_MAX_TOKENS_JUDGE,
        },
    };
}

/** CLI env = server env + wallet variables. Wallet variables are required (and read) only for CHAIN=baseSepolia. */
export function parseCliEnv(src: EnvSource): CliEnv {
    const server = parseServerEnv(src);
    const none = { agentPrivateKey: null, ownerPrivateKey: null, ownerAddress: null, feeRecipientAddress: null };
    if (server.chain !== "baseSepolia") return { ...server, ...none };
    const r = walletSchema.safeParse(withoutEmpty(src));
    if (!r.success) throw envError(r.error.issues);
    return {
        ...server,
        agentPrivateKey: r.data.AGENT_PRIVATE_KEY as `0x${string}`,
        ownerPrivateKey: r.data.OWNER_PRIVATE_KEY as `0x${string}`,
        ownerAddress: r.data.OWNER_ADDRESS as `0x${string}`,
        feeRecipientAddress: r.data.FEE_RECIPIENT_ADDRESS as `0x${string}`,
    };
}
