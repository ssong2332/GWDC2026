import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    AB_JUDGE_INPUT,
    AB_MISMATCH_INPUT,
    AB_POLICY_INPUT,
    MISMATCH_AB_MODES,
    POLICY_AB_MODES,
    THINKING_MODES,
    comparePolicyFields,
    createRequestGuard,
    formatAbMarkdown,
    formatPolicyFieldTable,
    judgeMismatchGate,
    measureMismatchAb,
    measurePolicyAb,
    measureThinkingAb,
    parseCaseArg,
    parseFlowArg,
    savingsPct,
    summarizeAb,
    type AbSample,
    type PolicyAbSample,
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

/** statusFor(i): HTTP status for the i-th request (1-based); "network" throws, "garbled" is a 200 with an unparseable body.
 *  fitsFor(i): the fits_purpose answer of the i-th request (default true — T-18 passes false for the mismatch case). */
function fakeKiln(statusFor: (i: number) => number | "network" | "garbled" = () => 200, fitsFor: (i: number) => boolean = () => true) {
    const seen: Seen[] = [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        seen.push({ body, auth: new Headers(init?.headers).get("authorization") });
        const i = seen.length;
        const status = statusFor(i);
        if (status === "network") throw new TypeError("fetch failed: ECONNRESET");
        if (status === "garbled") return new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
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
                            tool_calls: [{ id: "t", type: "function", function: { name: "submit_intent_judgment", arguments: JSON.stringify({ fits_purpose: fitsFor(i), reason: fitsFor(i) ? "ok" : "not an event expense" }) } }],
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

    // T-13 ① (T-11 review #1): the stop record must reflect the last real non-2xx response, not the client's
    // refused retries (which the SDK reports as status-0 connection errors).
    it("error: 429 → the failed sample records httpStatus 429, 1 real attempt, KILN_RATE_LIMITED; stopped.code matches", async () => {
        const k = fakeKiln((i) => (i === 4 ? 429 : 200));
        const r = await measureThinkingAb(opts(k.fetch, []));
        const saved = JSON.parse(fs.readFileSync(r.filePath, "utf8"));
        expect(saved.samples[3]).toMatchObject({ mode: "default", run: 2, httpStatus: 429, attempts: 1, judgment: "error", reason: "KILN_RATE_LIMITED" });
        expect(r.stopped).toMatchObject({ httpStatus: 429, code: "KILN_RATE_LIMITED", message: "HTTP 429" });
        expect(saved.stopped).toMatchObject({ httpStatus: 429, code: "KILN_RATE_LIMITED" });
    });

    it("error: 503 → httpStatus 503, 1 real attempt, KILN_UNAVAILABLE", async () => {
        const k = fakeKiln(() => 503);
        const r = await measureThinkingAb(opts(k.fetch, []));
        expect(k.seen).toHaveLength(1);
        const saved = JSON.parse(fs.readFileSync(r.filePath, "utf8"));
        expect(saved.samples).toHaveLength(1);
        expect(saved.samples[0]).toMatchObject({ httpStatus: 503, attempts: 1, reason: "KILN_UNAVAILABLE" });
        expect(r.stopped).toMatchObject({ mode: "default", run: 1, httpStatus: 503, code: "KILN_UNAVAILABLE" });
    });

    it("error: network error → 1 real request, sample httpStatus null with 1 attempt, stopped status 0 / KILN_UNAVAILABLE", async () => {
        const k = fakeKiln(() => "network");
        const r = await measureThinkingAb(opts(k.fetch, []));
        expect(k.seen).toHaveLength(1);
        const saved = JSON.parse(fs.readFileSync(r.filePath, "utf8"));
        expect(saved.samples[0]).toMatchObject({ httpStatus: null, attempts: 1, reason: "KILN_UNAVAILABLE" });
        expect(r.stopped).toMatchObject({ httpStatus: 0, code: "KILN_UNAVAILABLE" });
    });

    // T-13 ② (T-11 review #2): a 2xx whose body cannot be parsed must halt too — the client's retry must not reach the network.
    it(
        "error: 2xx with an unparseable body on the 2nd request → halts, no extra real request, sample excluded from averages",
        async () => {
            const k = fakeKiln((i) => (i === 2 ? "garbled" : 200));
            const r = await measureThinkingAb(opts(k.fetch, []));
            expect(k.seen).toHaveLength(2);
            expect(r.httpRequests).toBe(2);
            expect(r.stopped).toMatchObject({ mode: "kwargs_off", run: 1, httpStatus: 0, code: "KILN_UNAVAILABLE" });
            expect(r.stopped!.message).toMatch(/HTTP 200/);
            const saved = JSON.parse(fs.readFileSync(r.filePath, "utf8"));
            expect(saved.samples[1]).toMatchObject({ mode: "kwargs_off", httpStatus: null, attempts: 1, judgment: "error" });
            expect(r.summary!.modes.find((m) => m.mode === "kwargs_off")).toMatchObject({ runs: 1, ok: 0 });
        },
        20_000,
    );

    // T-13 ③ (T-11 review #3): the key never leaks on the stop paths either.
    it.each([
        ["429", (i: number) => (i === 1 ? 429 : 200)],
        ["402", () => 402],
        ["network error", () => "network" as const],
        ["unparseable 2xx", () => "garbled" as const],
    ] as const)("the API key is not in stopped, halt message, log lines, file or stdout text on the %s stop path", async (_name, statusFor) => {
        const k = fakeKiln(statusFor);
        const logs: string[] = [];
        const r = await measureThinkingAb(opts(k.fetch, logs));
        expect(k.seen[0].auth).toBe(`Bearer ${KEY}`);
        expect(r.stopped).not.toBeNull();
        expect(logs.length).toBeGreaterThan(0);
        // stdout text = the Markdown table + the stop line main() prints from `stopped`
        const texts = [JSON.stringify(r.stopped), r.stopped!.message, fs.readFileSync(r.filePath, "utf8"), r.markdown, ...logs];
        for (const text of texts) expect(text).not.toContain(KEY);
    }, 20_000);
});

// ---- T-14 / F-16 ④: policy_parse flow (default vs no_think × 3 runs = 6 real requests) ----

const policy = (over: Partial<NonNullable<PolicyAbSample["policy"]>> = {}): NonNullable<PolicyAbSample["policy"]> => ({
    budget: "200000",
    approvalThreshold: "50000",
    merchantIds: ["daiso", "coupang"],
    expiresOn: null,
    purpose: "Event expenses",
    unrecognizedMerchants: [],
    ...over,
});

const pSample = (mode: AbSample["mode"], run: number, over: Partial<PolicyAbSample> = {}): PolicyAbSample => ({
    ...sample({ mode, run, judgment: "ok", reason: "" }),
    policy: policy(),
    rawArguments: "{}",
    ...over,
});

/** default 1..3 and no_think 1..3, each with the same policy unless overridden by `patch(mode, run)`. */
const sixSamples = (patch: (mode: AbSample["mode"], run: number) => Partial<PolicyAbSample> = () => ({})) =>
    POLICY_AB_MODES.flatMap((mode) => [1, 2, 3].map((run) => pSample(mode, run, patch(mode, run))));

describe("comparePolicyFields (per-field agreement within each mode and across modes — OQ #24 conservative gate)", () => {
    it("normal: 6 identical extractions → every field agrees, gate same", () => {
        const c = comparePolicyFields(sixSamples());
        expect(c.rows.map((r) => r.field)).toEqual(["parseResult", "budget", "approvalThreshold", "merchantIds", "expiresOn", "purpose", "unrecognizedMerchants"]);
        for (const r of c.rows) expect(r).toMatchObject({ sameWithinMode: { default: true, no_think: true }, sameAcrossModes: true, allSame: true });
        expect(c.rows.find((r) => r.field === "budget")!.values).toEqual({ default: ["200000", "200000", "200000"], no_think: ["200000", "200000", "200000"] });
        expect(c.gate).toBe("same");
        expect(c.differingFields).toEqual([]);
    });

    it("boundary: only purpose wording differs in one no_think run → purpose differs (free-text counts), gate different", () => {
        const c = comparePolicyFields(sixSamples((m, r) => (m === "no_think" && r === 2 ? { policy: policy({ purpose: "Event costs" }) } : {})));
        const p = c.rows.find((r) => r.field === "purpose")!;
        expect(p).toMatchObject({ sameWithinMode: { default: true, no_think: false }, sameAcrossModes: false, allSame: false });
        expect(c.rows.find((r) => r.field === "budget")!.allSame).toBe(true);
        expect(c.gate).toBe("different");
        expect(c.differingFields).toEqual(["purpose"]);
    });

    it("boundary: variation inside both modes with the same value set → across-modes true but allSame false, gate different; merchant order counts", () => {
        const c = comparePolicyFields(
            sixSamples((m, r) => ((m === "default" && r === 3) || (m === "no_think" && r === 1) ? { policy: policy({ merchantIds: ["coupang", "daiso"] }) } : {})),
        );
        const mer = c.rows.find((r) => r.field === "merchantIds")!;
        expect(mer).toMatchObject({ sameWithinMode: { default: false, no_think: false }, sameAcrossModes: true, allSame: false });
        expect(c.gate).toBe("different");
    });

    it("error: a run whose extraction failed validation → parseResult differs, its fields recorded as '-', gate different", () => {
        const c = comparePolicyFields(sixSamples((m, r) => (m === "no_think" && r === 3 ? { judgment: "SCHEMA_INVALID", reason: "purpose: too long", policy: null } : {})));
        expect(c.rows.find((r) => r.field === "parseResult")!.values.no_think).toEqual(["ok", "ok", "SCHEMA_INVALID"]);
        expect(c.rows.find((r) => r.field === "budget")!.values.no_think[2]).toBe("-");
        expect(c.gate).toBe("different");
        expect(c.differingFields).toContain("parseResult");
    });

    it("error: a missing run or an HTTP failure → gate undetermined; no samples or unknown mode → RangeError", () => {
        expect(comparePolicyFields(sixSamples().slice(0, 5)).gate).toBe("undetermined");
        expect(comparePolicyFields(sixSamples((m, r) => (m === "default" && r === 2 ? { httpStatus: 429, judgment: "KILN_RATE_LIMITED", policy: null } : {}))).gate).toBe(
            "undetermined",
        );
        expect(() => comparePolicyFields([])).toThrow(RangeError);
        expect(() => comparePolicyFields([pSample("kwargs_off", 1)])).toThrow(/mode/);
    });
});

describe("formatPolicyFieldTable", () => {
    it("one row per field with per-mode values and agreement marks, plus the gate line", () => {
        const text = formatPolicyFieldTable(comparePolicyFields(sixSamples((m, r) => (m === "no_think" && r === 2 ? { policy: policy({ purpose: "Event costs" }) } : {}))));
        const purposeLine = text.split("\n").find((l) => l.startsWith("| purpose"))!;
        expect(purposeLine).toContain('"Event costs"');
        expect(purposeLine).toMatch(/\| NO \|$/);
        expect(text.split("\n").find((l) => l.startsWith("| budget"))).toMatch(/\| YES \|$/);
        expect(text).toMatch(/Gate: DIFFERENT/);
    });
});

describe("parseFlowArg (flow selection — no argument keeps the T-11 intent_judge run)", () => {
    it("undefined → intent_judge, policy_parse → policy_parse, anything else → error", () => {
        expect(parseFlowArg(undefined)).toBe("intent_judge");
        expect(parseFlowArg("intent_judge")).toBe("intent_judge");
        expect(parseFlowArg("policy_parse")).toBe("policy_parse");
        expect(() => parseFlowArg("policy")).toThrow(/flow/);
    });
});

/** A fake Kiln answering submit_spending_policy; argsFor(i) overrides the arguments of the i-th request. */
function fakePolicyKiln(statusFor: (i: number) => number = () => 200, argsFor: (i: number) => Record<string, unknown> = () => ({})) {
    const seen: Seen[] = [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        seen.push({ body, auth: new Headers(init?.headers).get("authorization") });
        const i = seen.length;
        const status = statusFor(i);
        if (status !== 200) return new Response(JSON.stringify({ error: { message: "nope" } }), { status, headers: { "content-type": "application/json" } });
        const thinking = !JSON.stringify(body.messages).includes("/no_think");
        const args = {
            total_budget_krw: 200000,
            approval_threshold_krw: 50000,
            allowed_merchant_ids: ["daiso", "coupang"],
            expires_on: null,
            purpose: "Event expenses",
            unrecognized_merchants: [],
            ...argsFor(i),
        };
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
                        message: { role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: { name: "submit_spending_policy", arguments: JSON.stringify(args) } }] },
                    },
                ],
                usage: {
                    prompt_tokens: 900,
                    completion_tokens: thinking ? 400 : 80,
                    total_tokens: thinking ? 1300 : 980,
                    completion_tokens_details: { reasoning_tokens: thinking ? 320 : 0 },
                },
            }),
            { status: 200, headers: { "content-type": "application/json", "x-neocloud-generation-id": `gen-${i}` } },
        );
    };
    return { fetch: fetch as typeof globalThis.fetch, seen };
}

const pOpts = (fetch: typeof globalThis.fetch, logs: string[]) => ({
    apiKey: KEY,
    baseURL: "https://kiln.test/v1",
    model: "qwen3-32b",
    maxTokensParse: 2048,
    fetch,
    outDir: dir,
    now: () => new Date("2026-09-29T01:02:03.456Z"),
    log: (line: string) => logs.push(line),
});

describe("measurePolicyAb (fake Kiln)", () => {
    it("default/no_think × 3 = exactly 6 requests round-robin, extracted fields + tokens saved, gate same", async () => {
        const k = fakePolicyKiln();
        const r = await measurePolicyAb(pOpts(k.fetch, []));

        expect(POLICY_AB_MODES).toEqual(["default", "no_think"]);
        expect(k.seen).toHaveLength(6);
        expect(r.httpRequests).toBe(6);
        expect(r.stopped).toBeNull();
        const noThink = (b: Record<string, unknown>) => JSON.stringify(b.messages).includes("/no_think");
        expect(k.seen.map((s) => (noThink(s.body) ? "no_think" : "default"))).toEqual(["default", "no_think", "default", "no_think", "default", "no_think"]);
        for (const s of k.seen) {
            expect(s.body.chat_template_kwargs).toBeUndefined();
            expect(JSON.stringify(s.body.tools)).toContain("submit_spending_policy");
            expect(JSON.stringify(s.body.messages)).toContain(AB_POLICY_INPUT.delegationText);
        }
        expect(AB_POLICY_INPUT.delegationText).toBe(AB_JUDGE_INPUT.delegationText);

        expect(r.comparison!.gate).toBe("same");
        expect(r.summary!.modes[1]).toMatchObject({ mode: "no_think", avgReasoningTokens: 0, reasoningSavingsPct: 100 });
        const saved = JSON.parse(fs.readFileSync(r.filePath, "utf8"));
        expect(path.basename(r.filePath)).toMatch(/^thinking-ab-policy_parse-/);
        expect(saved).toMatchObject({ task: "T-14", flow: "policy_parse", httpRequestBudget: 6, httpRequestsSent: 6, modes: ["default", "no_think"] });
        expect(saved.samples).toHaveLength(6);
        expect(saved.samples[0]).toMatchObject({
            mode: "default",
            run: 1,
            generationId: "gen-1",
            reasoningTokens: 320,
            judgment: "ok",
            policy: { budget: "200000", approvalThreshold: "50000", merchantIds: ["daiso", "coupang"], expiresOn: null, purpose: "Event expenses", unrecognizedMerchants: [] },
        });
        expect(saved.comparison.gate).toBe("same");
        expect(r.fieldTable).toContain("| budget");
    });

    it("a no_think run extracting a different threshold → gate different, the field is named", async () => {
        const k = fakePolicyKiln(undefined, (i) => (i === 4 ? { approval_threshold_krw: 30000 } : {}));
        const r = await measurePolicyAb(pOpts(k.fetch, []));
        expect(k.seen).toHaveLength(6);
        expect(r.comparison!.gate).toBe("different");
        expect(r.comparison!.differingFields).toEqual(["approvalThreshold"]);
    });

    it("error: 429 on the 3rd request → stops after 3 real requests, no retry, gate undetermined", async () => {
        const k = fakePolicyKiln((i) => (i === 3 ? 429 : 200));
        const r = await measurePolicyAb(pOpts(k.fetch, []));
        expect(k.seen).toHaveLength(3);
        expect(r.stopped).toMatchObject({ mode: "default", run: 2, httpStatus: 429, code: "KILN_RATE_LIMITED" });
        expect(r.comparison!.gate).toBe("undetermined");
        const saved = JSON.parse(fs.readFileSync(r.filePath, "utf8"));
        expect(saved.samples[2]).toMatchObject({ httpStatus: 429, attempts: 1, judgment: "KILN_RATE_LIMITED", policy: null });
    });

    it.each([
        ["success", (): number => 200],
        ["402", (): number => 402],
    ] as const)("the API key is sent as auth but not in the file, tables or log lines (%s path)", async (_n, statusFor) => {
        const k = fakePolicyKiln(statusFor);
        const logs: string[] = [];
        const r = await measurePolicyAb(pOpts(k.fetch, logs));
        expect(k.seen[0].auth).toBe(`Bearer ${KEY}`);
        expect(logs.length).toBeGreaterThan(0);
        for (const text of [fs.readFileSync(r.filePath, "utf8"), r.markdown, r.fieldTable, JSON.stringify(r.stopped), ...logs]) expect(text).not.toContain(KEY);
    });
});

// ---- T-18 / F-16 ⑥: intent_judge "purpose mismatch" case (default vs no_think × 3 runs = 6 real requests) ----

describe("AB_MISMATCH_INPUT (the submitted evidence's step 5 judge input, verbatim)", () => {
    it("equals the Base Sepolia evidence package of step 5 (SpendPending flags 2) and its active policy", () => {
        type Rec = { kind: string; evidenceHash: string; package: Record<string, any> };
        const exp = JSON.parse(fs.readFileSync(path.resolve("evidence/base-sepolia/evidence.json"), "utf8")) as { records: Rec[] };
        const step5 = exp.records.find((r) => r.package.requestId === "0x35f42c26de1c33fdabed31a554fd64fc02c394f08af78f4e41d95de15e8543c3")!;
        expect(step5.package.judgment.status).toBe("mismatch");
        expect(step5.package.submission.agentReviewRequest).toBe(true);
        const pol = exp.records.find((r) => r.kind === "policy_set" && r.evidenceHash === step5.package.policyEvidenceHash)!;
        const merchant = pol.package.final.merchants.find((m: { id: string }) => m.id === step5.package.request.merchantId);
        expect(AB_MISMATCH_INPUT).toEqual({
            purpose: pol.package.final.purpose,
            delegationText: pol.package.delegationText,
            merchantName: merchant.displayName,
            amount: BigInt(step5.package.request.amount),
            itemDescription: step5.package.request.itemDescription,
        });
        expect(AB_MISMATCH_INPUT).toMatchObject({ merchantName: "Daiso", amount: 15_000n, itemDescription: "Personal gaming mouse", purpose: "Event expenses" });
    });
});

describe("parseCaseArg (no --case keeps the T-11 run)", () => {
    it("undefined/fit → fit, mismatch → mismatch, anything else → RangeError", () => {
        expect(parseCaseArg(undefined)).toBe("fit");
        expect(parseCaseArg("fit")).toBe("fit");
        expect(parseCaseArg("mismatch")).toBe("mismatch");
        expect(() => parseCaseArg("mis")).toThrow(/case/);
    });
});

const jSample = (mode: AbSample["mode"], run: number, over: Partial<AbSample> = {}) => sample({ mode, run, judgment: "mismatch", ...over });
const sixJudge = (patch: (mode: AbSample["mode"], run: number) => Partial<AbSample> = () => ({})) =>
    MISMATCH_AB_MODES.flatMap((mode) => [1, 2, 3].map((run) => jSample(mode, run, patch(mode, run))));

describe("judgeMismatchGate (no_think 3/3 mismatch = pass)", () => {
    it("normal: no_think 3/3 mismatch → pass (default's answers recorded but not gating)", () => {
        const g = judgeMismatchGate(sixJudge((m, r) => (m === "default" && r === 2 ? { judgment: "match" } : {})));
        expect(g.result).toBe("pass");
        expect(g.noThinkJudgments).toEqual(["mismatch", "mismatch", "mismatch"]);
        expect(g.defaultJudgments).toEqual(["mismatch", "match", "mismatch"]);
    });
    it("boundary: one no_think match → fail", () => {
        const g = judgeMismatchGate(sixJudge((m, r) => (m === "no_think" && r === 3 ? { judgment: "match" } : {})));
        expect(g.result).toBe("fail");
        expect(g.noThinkJudgments).toEqual(["mismatch", "mismatch", "match"]);
    });
    it("boundary: a no_think invalid_output (undecidable) → undetermined", () => {
        expect(judgeMismatchGate(sixJudge((m, r) => (m === "no_think" && r === 1 ? { judgment: "invalid_output" } : {}))).result).toBe("undetermined");
    });
    it("error: missing no_think run or an HTTP failure → undetermined", () => {
        expect(judgeMismatchGate(sixJudge().slice(0, 5)).result).toBe("undetermined");
        expect(judgeMismatchGate(sixJudge((m, r) => (m === "no_think" && r === 2 ? { httpStatus: 429, judgment: "error" } : {}))).result).toBe("undetermined");
    });
    it("error: no samples or an unknown mode → RangeError", () => {
        expect(() => judgeMismatchGate([])).toThrow(RangeError);
        expect(() => judgeMismatchGate([jSample("kwargs_off", 1)])).toThrow(/mode/);
    });
});

describe("measureMismatchAb (fake Kiln)", () => {
    it("default/no_think × 3 = exactly 6 requests round-robin with the step 5 input, file saved, gate pass", async () => {
        const k = fakeKiln(undefined, () => false);
        const r = await measureMismatchAb(opts(k.fetch, []));

        expect(MISMATCH_AB_MODES).toEqual(["default", "no_think"]);
        expect(k.seen).toHaveLength(6);
        expect(r.httpRequests).toBe(6);
        expect(r.stopped).toBeNull();
        const noThink = (b: Record<string, unknown>) => JSON.stringify(b.messages).includes("/no_think");
        expect(k.seen.map((s) => (noThink(s.body) ? "no_think" : "default"))).toEqual(["default", "no_think", "default", "no_think", "default", "no_think"]);
        for (const s of k.seen) {
            expect(s.body.chat_template_kwargs).toBeUndefined();
            const user = (s.body.messages as { content: string }[])[1].content;
            expect(user).toContain("Item: Personal gaming mouse");
            expect(user).toContain("Amount (KRW): 15000");
            expect(user).toContain("Merchant: Daiso");
        }
        expect(r.gate.result).toBe("pass");
        expect(r.summary!.modes.map((m) => m.mode)).toEqual(["default", "no_think"]);
        expect(r.markdown).toMatch(/Gate: PASS/);

        const saved = JSON.parse(fs.readFileSync(r.filePath, "utf8"));
        expect(path.basename(r.filePath)).toMatch(/^thinking-ab-intent_judge-mismatch-/);
        expect(saved).toMatchObject({ task: "T-18", flow: "intent_judge", case: "mismatch", httpRequestBudget: 6, httpRequestsSent: 6, modes: ["default", "no_think"] });
        expect(saved.input).toEqual({ ...AB_MISMATCH_INPUT, amount: "15000" });
        expect(saved.inputSource).toContain("evidence/base-sepolia/evidence.json");
        expect(saved.samples).toHaveLength(6);
        expect(saved.samples[0]).toMatchObject({
            mode: "default",
            run: 1,
            generationId: "gen-1",
            reasoningTokens: 250,
            judgment: "mismatch",
            reason: "not an event expense",
            agentReviewRequest: true,
        });
        expect(saved.gate.result).toBe("pass");
    });

    it("a no_think run answering match (request 4 = no_think run 2) → gate fail; that sample has agentReviewRequest false", async () => {
        const k = fakeKiln(undefined, (i) => i === 4);
        const r = await measureMismatchAb(opts(k.fetch, []));
        expect(k.seen).toHaveLength(6);
        expect(r.gate).toMatchObject({ result: "fail", noThinkJudgments: ["mismatch", "match", "mismatch"] });
        const saved = JSON.parse(fs.readFileSync(r.filePath, "utf8"));
        expect(saved.samples[3]).toMatchObject({ mode: "no_think", run: 2, judgment: "match", agentReviewRequest: false });
    });

    it("error: 429 on the 3rd request → stops after 3 real requests, no retry, gate undetermined", async () => {
        const k = fakeKiln((i) => (i === 3 ? 429 : 200), () => false);
        const r = await measureMismatchAb(opts(k.fetch, []));
        expect(k.seen).toHaveLength(3);
        expect(r.httpRequests).toBe(3);
        expect(r.stopped).toMatchObject({ mode: "default", run: 2, httpStatus: 429, code: "KILN_RATE_LIMITED" });
        expect(r.gate.result).toBe("undetermined");
        const saved = JSON.parse(fs.readFileSync(r.filePath, "utf8"));
        expect(saved.samples[2]).toMatchObject({ httpStatus: 429, attempts: 1, judgment: "error" });
    });

    it(
        "error: 2xx with an unparseable body on the 2nd request → halts after 2 real requests, gate undetermined",
        async () => {
            const k = fakeKiln((i) => (i === 2 ? "garbled" : 200), () => false);
            const r = await measureMismatchAb(opts(k.fetch, []));
            expect(k.seen).toHaveLength(2);
            expect(r.stopped).toMatchObject({ mode: "no_think", run: 1, httpStatus: 0 });
            expect(r.gate.result).toBe("undetermined");
        },
        20_000,
    );

    it.each([
        ["success", (): number | "network" => 200],
        ["402", (): number | "network" => 402],
        ["network error", (): number | "network" => "network"],
    ] as const)("the API key is sent as auth but not in the file, Markdown, stopped, gate or log lines (%s path)", async (_n, statusFor) => {
        const k = fakeKiln(statusFor, () => false);
        const logs: string[] = [];
        const r = await measureMismatchAb(opts(k.fetch, logs));
        expect(k.seen[0].auth).toBe(`Bearer ${KEY}`);
        expect(logs.length).toBeGreaterThan(0);
        for (const text of [fs.readFileSync(r.filePath, "utf8"), r.markdown, JSON.stringify(r.stopped), JSON.stringify(r.gate), ...logs]) expect(text).not.toContain(KEY);
    });
});
