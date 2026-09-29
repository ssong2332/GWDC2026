import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    AB_JUDGE_INPUT,
    THINKING_MODES,
    createRequestGuard,
    formatAbMarkdown,
    measureThinkingAb,
    savingsPct,
    summarizeAb,
    type AbSample,
} from "../../cli/thinking-ab";

// T-11 / F-16: thinking mode A/B on the intent_judge flow. Pure aggregation + a fake Kiln (fake fetch) — no network.

const sample = (over: Partial<AbSample> = {}): AbSample => ({
    mode: "default",
    run: 1,
    httpStatus: 200,
    attempts: 1,
    latencyMs: 1000,
    promptTokens: 400,
    completionTokens: 300,
    reasoningTokens: 200,
    totalTokens: 700,
    cachedTokens: null,
    costUsd: null,
    finishReason: "tool_calls",
    generationId: "gen-1",
    judgment: "match",
    reason: "fits",
    ...over,
});

describe("savingsPct (reduction vs the default baseline, %)", () => {
    it("normal: 200 → 50 is a 75% reduction", () => {
        expect(savingsPct(200, 50)).toBe(75);
    });
    it("boundary: value 0 → 100%, value above baseline → negative (increase), rounded to 0.1", () => {
        expect(savingsPct(300, 0)).toBe(100);
        expect(savingsPct(300, 400)).toBe(-33.3);
    });
    it("boundary: baseline 0 or null / value null → null (no division by zero)", () => {
        expect(savingsPct(0, 10)).toBeNull();
        expect(savingsPct(null, 10)).toBeNull();
        expect(savingsPct(100, null)).toBeNull();
    });
});

describe("summarizeAb", () => {
    it("normal: per-mode averages, savings vs default, judgments agree", () => {
        const s = summarizeAb([
            sample({ mode: "default", run: 1, reasoningTokens: 200, completionTokens: 300, totalTokens: 700, latencyMs: 4000 }),
            sample({ mode: "default", run: 2, reasoningTokens: 100, completionTokens: 200, totalTokens: 600, latencyMs: 2000 }),
            sample({ mode: "kwargs_off", run: 1, reasoningTokens: 0, completionTokens: 60, totalTokens: 460, latencyMs: 1000 }),
            sample({ mode: "kwargs_off", run: 2, reasoningTokens: 0, completionTokens: 40, totalTokens: 440, latencyMs: 500 }),
            sample({ mode: "no_think", run: 1, reasoningTokens: 30, completionTokens: 125, totalTokens: 525, latencyMs: 1500 }),
        ]);
        expect(s.modes.map((m) => m.mode)).toEqual(["default", "kwargs_off", "no_think"]);
        const [d, k, n] = s.modes;
        expect(d).toMatchObject({ runs: 2, ok: 2, avgReasoningTokens: 150, avgCompletionTokens: 250, avgTotalTokens: 650, avgLatencyMs: 3000 });
        expect(d.reasoningSavingsPct).toBeNull();
        expect(k).toMatchObject({ runs: 2, ok: 2, avgReasoningTokens: 0, reasoningSavingsPct: 100, completionSavingsPct: 80, totalSavingsPct: 30.8, latencySavingsPct: 75 });
        expect(n).toMatchObject({ runs: 1, avgReasoningTokens: 30, reasoningSavingsPct: 80, completionSavingsPct: 50, latencySavingsPct: 50 });
        expect(s.judgmentsAgree).toBe(true);
        expect(d.judgments).toEqual(["match", "match"]);
    });

    it("boundary: a different judgment in one mode → judgmentsAgree false; failed HTTP samples are left out of the averages", () => {
        const s = summarizeAb([
            sample({ mode: "default", run: 1, reasoningTokens: 100 }),
            sample({ mode: "default", run: 2, httpStatus: 429, reasoningTokens: null, promptTokens: 0, completionTokens: 0, totalTokens: 0, judgment: "error" }),
            sample({ mode: "no_think", run: 1, judgment: "mismatch" }),
        ]);
        expect(s.judgmentsAgree).toBe(false);
        expect(s.modes[0]).toMatchObject({ runs: 2, ok: 1, avgReasoningTokens: 100, avgPromptTokens: 400 });
        expect(s.modes[1]).toMatchObject({ mode: "no_think", judgments: ["mismatch"] });
    });

    it("boundary: reasoning tokens never reported → average and reasoning savings null", () => {
        const s = summarizeAb([sample({ mode: "default", reasoningTokens: null }), sample({ mode: "kwargs_off", reasoningTokens: null })]);
        expect(s.modes[0].avgReasoningTokens).toBeNull();
        expect(s.modes[1].reasoningSavingsPct).toBeNull();
    });

    it("error: no samples → RangeError", () => {
        expect(() => summarizeAb([])).toThrow(RangeError);
    });

    it("error: unknown mode or invalid token counts → RangeError", () => {
        expect(() => summarizeAb([sample({ mode: "turbo" as AbSample["mode"] })])).toThrow(/mode/);
        expect(() => summarizeAb([sample({ promptTokens: -1 })])).toThrow(RangeError);
        expect(() => summarizeAb([sample({ reasoningTokens: 1.5 })])).toThrow(RangeError);
    });
});

describe("formatAbMarkdown", () => {
    it("one row per mode, baseline marked, judgment agreement line", () => {
        const text = formatAbMarkdown(
            summarizeAb([sample({ mode: "default", reasoningTokens: 200 }), sample({ mode: "kwargs_off", reasoningTokens: 0, judgment: "mismatch" })]),
        );
        const lines = text.split("\n");
        expect(lines.find((l) => l.startsWith("| default"))).toContain("baseline");
        expect(lines.find((l) => l.startsWith("| kwargs_off"))).toMatch(/\| 100% \|/);
        expect(text).toMatch(/Judgments agree across modes: NO/);
    });
});

describe("createRequestGuard (hard cap on real HTTP requests, no retries after a failure)", () => {
    const ok = async () => new Response("{}", { status: 200 });

    it("passes requests up to the limit, then refuses without calling the network", async () => {
        let inner = 0;
        const g = createRequestGuard(2, async () => {
            inner++;
            return ok();
        });
        await g.fetch("https://kiln.test/v1");
        await g.fetch("https://kiln.test/v1");
        await expect(g.fetch("https://kiln.test/v1")).rejects.toThrow(/budget/);
        expect(inner).toBe(2);
        expect(g.sent()).toBe(2);
    });

    it("a non-2xx response halts every later request (the client's own retry never reaches the network)", async () => {
        let inner = 0;
        const g = createRequestGuard(9, async () => {
            inner++;
            return new Response("{}", { status: 429 });
        });
        expect((await g.fetch("https://kiln.test/v1")).status).toBe(429);
        await expect(g.fetch("https://kiln.test/v1")).rejects.toThrow(/halted/);
        expect(inner).toBe(1);
        expect(g.halt()).toEqual({ status: 429, message: "HTTP 429" });
    });

    it("a network error halts too", async () => {
        const g = createRequestGuard(9, async () => {
            throw new Error("ECONNRESET");
        });
        await expect(g.fetch("https://kiln.test/v1")).rejects.toThrow("ECONNRESET");
        await expect(g.fetch("https://kiln.test/v1")).rejects.toThrow(/halted/);
        expect(g.halt()?.status).toBe(0);
    });
});

// ---- script flow with a fake Kiln (fake fetch) ----

const KEY = "sk-test-key-must-not-leak-0123456789";

type Seen = { body: Record<string, unknown>; auth: string | null };

function fakeKiln(statusFor: (i: number) => number = () => 200) {
    const seen: Seen[] = [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        seen.push({ body, auth: new Headers(init?.headers).get("authorization") });
        const i = seen.length;
        const status = statusFor(i);
        if (status !== 200) return new Response(JSON.stringify({ error: { message: "nope" } }), { status, headers: { "content-type": "application/json" } });
        const thinking = body.chat_template_kwargs === undefined && !JSON.stringify(body.messages).includes("/no_think");
        return new Response(
            JSON.stringify({
                id: `c${i}`,
                object: "chat.completion",
                created: 1,
                model: "qwen3-32b",
                choices: [
                    {
                        index: 0,
                        finish_reason: "tool_calls",
                        message: {
                            role: "assistant",
                            content: null,
                            tool_calls: [{ id: "t", type: "function", function: { name: "submit_intent_judgment", arguments: '{"fits_purpose": true, "reason": "ok"}' } }],
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 500,
                    completion_tokens: thinking ? 300 : 50,
                    total_tokens: thinking ? 800 : 550,
                    completion_tokens_details: { reasoning_tokens: thinking ? 250 : 0 },
                },
            }),
            { status: 200, headers: { "content-type": "application/json", "x-neocloud-generation-id": `gen-${i}` } },
        );
    };
    return { fetch: fetch as typeof globalThis.fetch, seen };
}

let dir: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "thinking-ab-"));
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

const opts = (fetch: typeof globalThis.fetch, logs: string[]) => ({
    apiKey: KEY,
    baseURL: "https://kiln.test/v1",
    model: "qwen3-32b",
    maxTokensJudge: 1024,
    fetch,
    outDir: dir,
    now: () => new Date("2026-09-29T01:02:03.456Z"),
    log: (line: string) => logs.push(line),
});

describe("measureThinkingAb (fake Kiln)", () => {
    it("3 modes × 3 runs = exactly 9 requests with the per-mode body, file saved, aggregated per mode", async () => {
        const k = fakeKiln();
        const logs: string[] = [];
        const r = await measureThinkingAb(opts(k.fetch, logs));

        expect(THINKING_MODES).toEqual(["default", "kwargs_off", "no_think"]);
        expect(k.seen).toHaveLength(9);
        expect(r.httpRequests).toBe(9);
        expect(r.stopped).toBeNull();
        // round-robin order: run 1 = default, kwargs_off, no_think, ...
        const modeOf = (b: Record<string, unknown>) =>
            b.chat_template_kwargs ? "kwargs_off" : JSON.stringify(b.messages).includes("/no_think") ? "no_think" : "default";
        expect(k.seen.map((s) => modeOf(s.body))).toEqual(["default", "kwargs_off", "no_think", "default", "kwargs_off", "no_think", "default", "kwargs_off", "no_think"]);
        const [dflt, kw, nt] = k.seen;
        expect(dflt.body.chat_template_kwargs).toBeUndefined();
        expect(kw.body.chat_template_kwargs).toEqual({ enable_thinking: false });
        expect((nt.body.messages as { content: string }[])[0].content.endsWith("\n/no_think")).toBe(true);
        expect((dflt.body.messages as { content: string }[])[1].content).toContain(AB_JUDGE_INPUT.itemDescription);

        const [d, kwRow, ntRow] = r.summary!.modes;
        expect(d).toMatchObject({ mode: "default", runs: 3, ok: 3, avgReasoningTokens: 250, avgCompletionTokens: 300 });
        expect(kwRow).toMatchObject({ mode: "kwargs_off", avgReasoningTokens: 0, reasoningSavingsPct: 100 });
        expect(ntRow).toMatchObject({ mode: "no_think", avgReasoningTokens: 0 });
        expect(r.summary!.judgmentsAgree).toBe(true);

        const saved = JSON.parse(fs.readFileSync(r.filePath, "utf8"));
        expect(path.dirname(r.filePath)).toBe(dir);
        expect(saved.samples).toHaveLength(9);
        expect(saved.samples[0]).toMatchObject({ mode: "default", run: 1, generationId: "gen-1", reasoningTokens: 250, judgment: "match" });
        expect(saved.input.amount).toBe(AB_JUDGE_INPUT.amount.toString());
        expect(saved.httpRequestBudget).toBe(9);
        expect(r.markdown).toContain("| kwargs_off");
    });

    it("the API key is sent as auth but never appears in the file, the Markdown or the log lines (F-16 ③)", async () => {
        const k = fakeKiln();
        const logs: string[] = [];
        const r = await measureThinkingAb(opts(k.fetch, logs));
        expect(k.seen[0].auth).toBe(`Bearer ${KEY}`);
        expect(logs.length).toBeGreaterThan(0);
        for (const text of [fs.readFileSync(r.filePath, "utf8"), r.markdown, ...logs]) expect(text).not.toContain(KEY);
    });

    it("error: a 429 on the 4th request stops the run — no retry, no extra calls, partial file saved with the stop", async () => {
        const k = fakeKiln((i) => (i === 4 ? 429 : 200));
        const r = await measureThinkingAb(opts(k.fetch, []));
        expect(k.seen).toHaveLength(4);
        expect(r.httpRequests).toBe(4);
        expect(r.stopped).toMatchObject({ mode: "default", run: 2, httpStatus: 429 });
        const saved = JSON.parse(fs.readFileSync(r.filePath, "utf8"));
        expect(saved.stopped).toMatchObject({ httpStatus: 429 });
        expect(saved.samples).toHaveLength(4);
    });

    it("error: 402 (credits) on the first request → stops after 1 request", async () => {
        const k = fakeKiln(() => 402);
        const r = await measureThinkingAb(opts(k.fetch, []));
        expect(k.seen).toHaveLength(1);
        expect(r.stopped).toMatchObject({ mode: "default", run: 1, httpStatus: 402, code: "KILN_CREDIT_EXHAUSTED" });
    });
});
