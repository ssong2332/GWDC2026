import { describe, expect, it } from "vitest";
import { parseCliEnv, parseServerEnv } from "@/config/env";
import { AppError } from "@/core/errors";

// Placeholder-shaped test values only (no real keys): 32 bytes of 0x11 / 0x22.
const AGENT_KEY = `0x${"11".repeat(32)}`;
const OWNER_KEY = `0x${"22".repeat(32)}`;
const OWNER_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FEE_ADDR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const sepolia = {
    CHAIN: "baseSepolia",
    RPC_URL: "https://sepolia.base.org",
    AGENT_PRIVATE_KEY: AGENT_KEY,
    OWNER_PRIVATE_KEY: OWNER_KEY,
    OWNER_ADDRESS: OWNER_ADDR,
    FEE_RECIPIENT_ADDRESS: FEE_ADDR,
};

function envError(fn: () => unknown): AppError {
    try {
        fn();
    } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        return err as AppError;
    }
    throw new Error("expected an ENV_INVALID error");
}

describe("parseServerEnv (src/config/env.ts — pure, ADR-0005)", () => {
    it("an empty environment gives the documented defaults (tests run without .env)", () => {
        expect(parseServerEnv({})).toEqual({
            chain: "localhost",
            rpcUrl: "http://127.0.0.1:8545",
            databasePath: "data.local/app.sqlite",
            kiln: {
                mode: "fake",
                apiKey: null,
                baseUrl: "https://api.bricksum.com/v1",
                model: "qwen3-32b",
                thinkingMode: "no_think",
                maxTokensParse: 2048,
                maxTokensJudge: 1024,
            },
        });
    });

    it("reads every variable and never returns private keys even if they are present", () => {
        const env = parseServerEnv({
            ...sepolia,
            DATABASE_PATH: "data.local/x.sqlite",
            KILN_MODE: "real",
            KILN_API_KEY: "sk-bk-test-placeholder",
            KILN_THINKING_MODE: "no_think",
            KILN_MAX_TOKENS_PARSE: "500",
            KILN_MAX_TOKENS_JUDGE: "4096",
        });
        expect(env).toMatchObject({
            chain: "baseSepolia",
            rpcUrl: "https://sepolia.base.org",
            databasePath: "data.local/x.sqlite",
            kiln: { mode: "real", apiKey: "sk-bk-test-placeholder", thinkingMode: "no_think", maxTokensParse: 500, maxTokensJudge: 4096 },
        });
        expect(JSON.stringify(env)).not.toContain(AGENT_KEY.slice(2));
        expect(Object.keys(env)).toEqual(["chain", "rpcUrl", "databasePath", "kiln"]);
    });

    it("defaults KILN_THINKING_MODE to no_think when unset or empty (D-39, ADR-0007)", () => {
        expect(parseServerEnv({}).kiln.thinkingMode).toBe("no_think");
        expect(parseServerEnv({ KILN_THINKING_MODE: "" }).kiln.thinkingMode).toBe("no_think");
    });

    it.each(["default", "kwargs_off", "no_think"] as const)("keeps an explicit KILN_THINKING_MODE=%s", (mode) => {
        expect(parseServerEnv({ KILN_THINKING_MODE: mode }).kiln.thinkingMode).toBe(mode);
    });

    it("treats empty strings as unset (KEY= lines in an env file)", () => {
        expect(parseServerEnv({ CHAIN: "", KILN_API_KEY: "", KILN_MAX_TOKENS_PARSE: "" })).toMatchObject({
            chain: "localhost",
            kiln: { apiKey: null, maxTokensParse: 2048 },
        });
    });

    it.each<[string, Record<string, string>, string]>([
        ["max tokens 499 (< 500)", { KILN_MAX_TOKENS_PARSE: "499" }, "KILN_MAX_TOKENS_PARSE"],
        ["judge max tokens not a number", { KILN_MAX_TOKENS_JUDGE: "lots" }, "KILN_MAX_TOKENS_JUDGE"],
        ["unknown chain", { CHAIN: "mainnet" }, "CHAIN"],
        ["RPC_URL not a URL", { RPC_URL: "127.0.0.1:8545" }, "RPC_URL"],
        ["real Kiln without an API key", { KILN_MODE: "real" }, "KILN_API_KEY"],
        ["unknown thinking mode", { KILN_THINKING_MODE: "off" }, "KILN_THINKING_MODE"],
    ])("rejects %s with ENV_INVALID naming the variable", (_label, src, name) => {
        const err = envError(() => parseServerEnv(src));
        expect(err.code).toBe("ENV_INVALID");
        expect(err.message).toContain(name);
    });
});

describe("parseCliEnv (src/config/env.ts)", () => {
    it("localhost needs no keys; key variables are ignored for localhost", () => {
        const env = parseCliEnv({ AGENT_PRIVATE_KEY: "not-a-key" });
        expect(env).toMatchObject({ chain: "localhost", agentPrivateKey: null, ownerPrivateKey: null, ownerAddress: null, feeRecipientAddress: null });
    });

    it("baseSepolia with all four wallet variables → keys and checksummed addresses", () => {
        const env = parseCliEnv({ ...sepolia, OWNER_ADDRESS: OWNER_ADDR.toLowerCase() });
        expect(env).toMatchObject({
            chain: "baseSepolia",
            agentPrivateKey: AGENT_KEY,
            ownerPrivateKey: OWNER_KEY,
            ownerAddress: OWNER_ADDR,
            feeRecipientAddress: FEE_ADDR,
        });
    });

    it.each(["AGENT_PRIVATE_KEY", "OWNER_PRIVATE_KEY", "OWNER_ADDRESS", "FEE_RECIPIENT_ADDRESS"])(
        "baseSepolia without %s → ENV_INVALID naming it",
        (name) => {
            const src: Record<string, string> = { ...sepolia };
            delete src[name];
            const err = envError(() => parseCliEnv(src));
            expect(err.code).toBe("ENV_INVALID");
            expect(err.message).toContain(name);
        },
    );

    it("a malformed private key is reported by name without echoing its value", () => {
        const bad = `0x${"ab".repeat(31)}`; // 31 bytes
        const err = envError(() => parseCliEnv({ ...sepolia, OWNER_PRIVATE_KEY: bad }));
        expect(err.message).toContain("OWNER_PRIVATE_KEY");
        expect(err.message).not.toContain(bad);
        expect(err.message).not.toContain("ab".repeat(31));
    });

    it("a malformed address is rejected", () => {
        const err = envError(() => parseCliEnv({ ...sepolia, FEE_RECIPIENT_ADDRESS: "0x1234" }));
        expect(err.message).toContain("FEE_RECIPIENT_ADDRESS");
    });
});
