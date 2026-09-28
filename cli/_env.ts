import fs from "node:fs";
import path from "node:path";
import { parseCliEnv, type CliEnv } from "@/config/env";

// CLI env loader (ADR-0005): .env, then .env.cli (private keys live only there), each skipped when missing.
// process.loadEnvFile never overwrites a variable that is already set, so the process environment wins
// over files and the earlier file wins over the later one. Explicit overrides (CLI flags) win over all.
// Must not import src/server/**.

export const CLI_ENV_FILES = [".env", ".env.cli"] as const;

type LoadOptions = { cwd?: string; files?: readonly string[] };

/** Loads the env files into process.env without parsing (for commands that need no wallet variables). */
export function loadEnvFiles(opts: LoadOptions = {}): void {
    const cwd = opts.cwd ?? process.cwd();
    for (const file of opts.files ?? CLI_ENV_FILES) {
        const p = path.resolve(cwd, file);
        if (fs.existsSync(p)) process.loadEnvFile(p);
    }
}

export function loadCliEnv(opts: LoadOptions & { overrides?: Record<string, string | undefined> } = {}): CliEnv {
    loadEnvFiles(opts);
    const overrides = Object.fromEntries(Object.entries(opts.overrides ?? {}).filter(([, v]) => v !== undefined));
    return parseCliEnv({ ...process.env, ...overrides });
}
