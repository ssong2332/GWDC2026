import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INTEGRATION_RPC_URL, INTEGRATION_RPC_PORT } from "../helpers/rpc";

// Vitest globalSetup for layer ③ (Architecture 테스트 전략): starts `npx hardhat node --port 8546` in chain/,
// waits until it answers JSON-RPC, and kills the whole process tree on teardown.
//
// The node's clock and the agent nonce are shared state, so one run must own the node exclusively:
// - a machine-wide lock file serializes concurrent `test:int` runs (a second run waits for the first to finish);
// - the run only proceeds once *its own* child printed that it bound the port — another process's node answering
//   on 8546 is never mistaken for ours (that silent sharing made nonces and block timestamps collide).

const CHAIN_DIR = path.resolve(__dirname, "../../../chain");
const START_TIMEOUT_MS = 120_000;
const LOCK_WAIT_MS = 300_000;
const STOP_TIMEOUT_MS = 15_000;
const LOCK_PATH = path.join(os.tmpdir(), `gwdc2026-hardhat-node-${INTEGRATION_RPC_PORT}.lock`);
const BOUND_LINE = `JSON-RPC server at http://127.0.0.1:${INTEGRATION_RPC_PORT}/`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpcAlive(): Promise<boolean> {
    try {
        const res = await fetch(INTEGRATION_RPC_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

function killTree(child: ChildProcess): void {
    if (child.pid === undefined || child.exitCode !== null) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGTERM");
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** Takes the machine-wide lock for the integration port; waits while another live run holds it. */
async function acquireLock(): Promise<() => void> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
            return () => {
                try {
                    if (fs.readFileSync(LOCK_PATH, "utf8") === String(process.pid)) fs.unlinkSync(LOCK_PATH);
                } catch {
                    // already gone
                }
            };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
        let holder = Number.NaN;
        try {
            holder = Number.parseInt(fs.readFileSync(LOCK_PATH, "utf8"), 10);
        } catch {
            continue; // released between our attempt and this read
        }
        if (Number.isInteger(holder) && holder > 0 && !pidAlive(holder)) {
            fs.rmSync(LOCK_PATH, { force: true }); // stale lock from a run that died without teardown
            continue;
        }
        if (Date.now() > deadline)
            throw new Error(`another test:int run (pid ${holder}) still holds ${LOCK_PATH} after ${LOCK_WAIT_MS} ms`);
        await sleep(500);
    }
}

async function startOwnNode(): Promise<ChildProcess> {
    if (await rpcAlive())
        throw new Error(`port ${INTEGRATION_RPC_PORT} already answers JSON-RPC — stop the leftover node before running test:int`);

    const child = spawn("npx", ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(INTEGRATION_RPC_PORT)], {
        cwd: CHAIN_DIR,
        shell: process.platform === "win32",
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let bound = false;
    child.stdout?.on("data", (d) => {
        output = (output + String(d)).slice(-4000);
        if (output.includes(BOUND_LINE)) bound = true;
    });
    child.stderr?.on("data", (d) => (output = (output + String(d)).slice(-4000)));

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!(bound && (await rpcAlive()))) {
        if (child.exitCode !== null) throw new Error(`hardhat node exited early (code ${child.exitCode}):\n${output}`);
        if (Date.now() > deadline) {
            killTree(child);
            throw new Error(`hardhat node did not bind ${INTEGRATION_RPC_URL} within ${START_TIMEOUT_MS} ms:\n${output}`);
        }
        await sleep(500);
    }
    return child;
}

async function waitPortFree(): Promise<void> {
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while ((await rpcAlive()) && Date.now() < deadline) await sleep(250);
}

export default async function setup(): Promise<() => Promise<void>> {
    const releaseLock = await acquireLock();
    let child: ChildProcess;
    try {
        child = await startOwnNode();
    } catch (err) {
        releaseLock();
        throw err;
    }

    return async () => {
        killTree(child);
        await waitPortFree();
        releaseLock();
    };
}
