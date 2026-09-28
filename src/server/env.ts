import "server-only";
import { parseServerEnv, type EnvSource, type ServerEnv } from "@/config/env";
import { AppError } from "@/core/errors";

// Server-process env (ADR-0005). Private keys are CLI-only (D-16): if Next.js loaded one into the server
// process (e.g. from .env), refuse to start instead of silently carrying it.
const CLI_ONLY_KEYS = ["AGENT_PRIVATE_KEY", "OWNER_PRIVATE_KEY"] as const;

export function loadServerEnv(src: EnvSource = process.env): ServerEnv {
    const present = CLI_ONLY_KEYS.filter((k) => (src[k] ?? "") !== "");
    if (present.length > 0)
        throw new AppError(
            "PRIVATE_KEY_IN_SERVER_ENV",
            `${present.join(", ")} must not be loaded by the web server: move private keys to .env.cli (CLI only)`,
        );
    return parseServerEnv(src);
}
