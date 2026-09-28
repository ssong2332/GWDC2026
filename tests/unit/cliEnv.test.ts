import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_ENV_FILES, loadCliEnv } from "../../cli/_env";

// loadCliEnv loads env files into process.env (process.loadEnvFile), so each test restores it.
// The test files use neutral names — the real .env / .env.cli are never created or read here.

let saved: NodeJS.ProcessEnv;
let dir: string;
const TOUCHED = ["CHAIN", "RPC_URL", "DATABASE_PATH", "KILN_MODE", "KILN_MODEL"];

beforeEach(() => {
    saved = { ...process.env };
    for (const k of TOUCHED) delete process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-env-"));
});
afterEach(() => {
    // Restore in place: replacing process.env with a plain object would detach it from process.loadEnvFile.
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body, "utf8");

describe("loadCliEnv (cli/_env.ts)", () => {
    it("loads .env then .env.cli by default", () => {
        expect([...CLI_ENV_FILES]).toEqual([".env", ".env.cli"]);
    });

    it("loads the first file, fills the rest from the second, and parses the result", () => {
        write("first.txt", "DATABASE_PATH=data.local/first.sqlite\nKILN_MODEL=first-model\n");
        write("second.txt", "KILN_MODEL=second-model\nRPC_URL=http://127.0.0.1:9999\n");
        const env = loadCliEnv({ cwd: dir, files: ["first.txt", "second.txt"] });
        expect(env).toMatchObject({ databasePath: "data.local/first.sqlite", rpcUrl: "http://127.0.0.1:9999", kiln: { model: "first-model" } });
    });

    it("skips files that do not exist (tests and e2e:local run without env files)", () => {
        const env = loadCliEnv({ cwd: dir, files: ["missing-a.txt", "missing-b.txt"] });
        expect(env).toMatchObject({ chain: "localhost", rpcUrl: "http://127.0.0.1:8545" });
    });

    it("variables already in the process environment win over files; explicit overrides (CLI flags) win over both", () => {
        process.env.KILN_MODEL = "from-process";
        write("first.txt", "KILN_MODEL=from-file\nRPC_URL=http://127.0.0.1:7777\n");
        const env = loadCliEnv({ cwd: dir, files: ["first.txt"], overrides: { RPC_URL: "http://127.0.0.1:8545", CHAIN: undefined } });
        expect(env).toMatchObject({ rpcUrl: "http://127.0.0.1:8545", chain: "localhost", kiln: { model: "from-process" } });
    });

    it("an invalid value in a file surfaces as ENV_INVALID", () => {
        write("first.txt", "KILN_MODE=sometimes\n");
        expect(() => loadCliEnv({ cwd: dir, files: ["first.txt"] })).toThrow(/KILN_MODE/);
    });
});
