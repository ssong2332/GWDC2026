import { describe, expect, it } from "vitest";
import type { ApiResult } from "@/ui/apiClient";
import {
    initialOwnerActionState,
    isBusy,
    runOwnerAction,
    type OwnerActionPorts,
    type OwnerActionState,
    type PreparedAction,
} from "@/ui/wallet/ownerAction";

// useOwnerAction state machine (Architecture 10 서명 흐름):
// idle → preparing → simulating → awaiting_signature → confirming → done, any step → error.

const HASH = `0x${"22".repeat(32)}` as const;
const TX = `0x${"33".repeat(32)}` as const;
const prepared: PreparedAction = {
    evidenceId: "ev-1",
    evidenceHash: HASH,
    call: { functionName: "pause", args: [HASH] },
    vault: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    chainId: 31337,
};

function ports(over: Partial<OwnerActionPorts> = {}) {
    const log: string[] = [];
    const p: OwnerActionPorts = {
        prepare: async () => {
            log.push("prepare");
            return { ok: true, data: prepared };
        },
        simulate: async () => {
            log.push("simulate");
        },
        send: async () => {
            log.push("send");
            return TX;
        },
        confirm: async () => {
            log.push("confirm");
            return { ok: true, data: { status: "anchored", events: [] } };
        },
        ...over,
    };
    return { p, log };
}

async function run(p: OwnerActionPorts) {
    const states: OwnerActionState[] = [];
    const final = await runOwnerAction(p, { kind: "pause", owner: prepared.vault, note: "" }, (s) => states.push(s));
    return { final, steps: states.map((s) => s.step), states };
}

describe("runOwnerAction", () => {
    it("happy path walks every step in order and ends done with the tx hash", async () => {
        const { p, log } = ports();
        const { final, steps } = await run(p);
        expect(steps).toEqual(["preparing", "simulating", "awaiting_signature", "confirming", "done"]);
        expect(final).toEqual({ step: "done", txHash: TX, evidenceHash: HASH });
        expect(log).toEqual(["prepare", "simulate", "send", "confirm"]);
    });

    it("prepare API error (e.g. NOT_OWNER) stops before any wallet call", async () => {
        const { p, log } = ports({
            prepare: async () => ({ ok: false, status: 403, error: { code: "NOT_OWNER", message: "not owner" } }) as ApiResult<PreparedAction>,
        });
        const { final } = await run(p);
        expect(final).toEqual({ step: "error", at: "preparing", error: { code: "NOT_OWNER", message: "not owner" }, txHash: null });
        expect(log).toEqual([]);
    });

    it("simulation revert is shown before the signature prompt (no send)", async () => {
        const { p, log } = ports({
            simulate: async () => {
                throw Object.assign(new Error("reverted"), { code: "CONTRACT_ALREADY_PAUSED" });
            },
        });
        const { final } = await run(p);
        expect(final).toMatchObject({ step: "error", at: "simulating", txHash: null });
        expect(log).toEqual(["prepare"]);
    });

    it("user rejects the signature (4001) → error 'Signature rejected', nothing confirmed", async () => {
        const { p, log } = ports({
            send: async () => {
                throw Object.assign(new Error("User denied transaction signature"), { code: 4001 });
            },
        });
        const { final } = await run(p);
        expect(final).toEqual({
            step: "error",
            at: "awaiting_signature",
            error: { code: "SIGNATURE_REJECTED", message: "Signature rejected" },
            txHash: null,
        });
        expect(log).toEqual(["prepare", "simulate"]);
    });

    it("mined but reverted → TX_REVERTED with the tx hash kept for the user", async () => {
        const { p } = ports({ confirm: async () => ({ ok: true, data: { status: "reverted", events: [] } }) });
        const { final } = await run(p);
        expect(final).toMatchObject({ step: "error", at: "confirming", error: { code: "TX_REVERTED" }, txHash: TX });
    });

    it("confirm API failure (e.g. RPC down) keeps the tx hash", async () => {
        const { p } = ports({
            confirm: async () => ({ ok: false, status: 502, error: { code: "CHAIN_RPC_ERROR", message: "rpc" } }),
        });
        const { final } = await run(p);
        expect(final).toEqual({ step: "error", at: "confirming", error: { code: "CHAIN_RPC_ERROR", message: "rpc" }, txHash: TX });
    });

    it("a prepared call for another chain is refused before simulation (WRONG_NETWORK)", async () => {
        const { p, log } = ports({ prepare: async () => ({ ok: true, data: { ...prepared, chainId: 84532 } }) });
        const states: OwnerActionState[] = [];
        const final = await runOwnerAction(p, { kind: "pause", owner: prepared.vault, note: "" }, (s) => states.push(s), { walletChainId: 31337 });
        expect(final).toMatchObject({ step: "error", at: "simulating", error: { code: "WRONG_NETWORK" } });
        expect(log).toEqual([]); // the overridden prepare does not log; neither simulate nor send ran
    });
});

describe("isBusy / initial state", () => {
    it("idle, done and error are not busy; the in-flight steps are", () => {
        expect(initialOwnerActionState).toEqual({ step: "idle" });
        expect(isBusy({ step: "idle" })).toBe(false);
        expect(isBusy({ step: "done", txHash: TX, evidenceHash: HASH })).toBe(false);
        expect(isBusy({ step: "error", at: "preparing", error: { code: "X", message: "" }, txHash: null })).toBe(false);
        for (const step of ["preparing", "simulating", "awaiting_signature"] as const) expect(isBusy({ step })).toBe(true);
        expect(isBusy({ step: "confirming", txHash: TX })).toBe(true);
    });
});
