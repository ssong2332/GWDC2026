import { describe, expect, it } from "vitest";
import { OpenAiKilnClient } from "@/adapters/kiln/openaiKilnClient";
import { MERCHANT_REGISTRY } from "@/config/merchants";

// Fake fetch only — no network. Each queued step answers one HTTP attempt.
type Step =
    | { status: number; body?: unknown; headers?: Record<string, string> }
    | { throws: Error };

function fakeFetch(steps: Step[]) {
    const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")),
            headers: new Headers(init?.headers),
        });
        const step = steps.shift();
        if (!step) throw new Error("fake fetch: no step queued");
        if ("throws" in step) throw step.throws;
        return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
            status: step.status,
            headers: { "content-type": "application/json", ...(step.headers ?? {}) },
        });
    };
    return { fetch, requests };
}

const completion = (message: Record<string, unknown>, finish = "tool_calls", usage: Record<string, unknown> = {}) => ({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "qwen3-32b",
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: null, ...message } }],
    usage: { prompt_tokens: 812, completion_tokens: 240, total_tokens: 1052, ...usage },
});

const toolMessage = (name: string, args: string) => ({
    tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: args } }],
});

function client(steps: Step[]) {
    const f = fakeFetch(steps);
    const sleeps: number[] = [];
    const c = new OpenAiKilnClient({
        apiKey: "test-key-not-real",
        baseURL: "https://kiln.test/v1",
        body: { model: "qwen3-32b", maxTokensParse: 2048, maxTokensJudge: 1024, thinkingMode: "default" },
        fetch: f.fetch as typeof globalThis.fetch,
        sleep: async (ms) => {
            sleeps.push(ms);
        },
        random: () => 0.5,
    });
    return { c, sleeps, requests: f.requests };
}

const JUDGE = {
    purpose: "Event supplies",
    delegationText: "행사비 20만 원을 맡길게",
    merchantName: "Daiso",
    amount: 30_000n,
    itemDescription: "Balloons",
};
const PARSE = { delegationText: "행사비 20만 원을 맡길게", todayKst: "2026-09-28", merchants: MERCHANT_REGISTRY };

describe("OpenAiKilnClient — success paths and usage capture (F-01 ①, F-14 usage)", () => {
    it("returns the tool call and records usage, cost, reasoning tokens and X-Neocloud-Generation-Id", async () => {
        const { c, requests } = client([
            {
                status: 200,
                headers: { "x-neocloud-generation-id": "gen-abc" },
                body: completion(toolMessage("submit_intent_judgment", '{"fits_purpose":true,"reason":"ok"}'), "tool_calls", {
                    completion_tokens_details: { reasoning_tokens: 180 },
                    prompt_tokens_details: { cached_tokens: 64 },
                    cost: 0.000001155,
                }),
            },
        ]);
        const r = await c.judgeIntent(JUDGE);
        expect(r.outcome).toEqual({
            kind: "tool_call",
            functionName: "submit_intent_judgment",
            rawArguments: '{"fits_purpose":true,"reason":"ok"}',
        });
        expect(r.record).toMatchObject({
            flow: "intent_judge",
            provider: "kiln",
            model: "qwen3-32b",
            httpStatus: 200,
            finishReason: "tool_calls",
            attempts: 1,
            promptTokens: 812,
            completionTokens: 240,
            reasoningTokens: 180,
            totalTokens: 1052,
            cachedTokens: 64,
            costUsd: "0.000001155",
            generationId: "gen-abc",
            thinkingMode: "default",
        });
        expect(r.record.callId).toMatch(/^[0-9a-f-]{36}$/);
        expect(requests[0].url).toBe("https://kiln.test/v1/chat/completions");
        expect(requests[0].body).not.toHaveProperty("response_format");
        expect(requests[0].body.tool_choice).toBe("auto");
    });

    it("records reasoning/cached tokens and cost as null when the response omits them", async () => {
        const { c } = client([{ status: 200, body: completion(toolMessage("submit_spending_policy", "{}")) }]);
        const r = await c.parsePolicy(PARSE);
        expect(r.record).toMatchObject({
            flow: "policy_parse",
            reasoningTokens: null,
            cachedTokens: null,
            costUsd: null,
            generationId: null,
        });
    });

    it("returns no_tool_call with <think> blocks stripped from content", async () => {
        const { c } = client([
            { status: 200, body: completion({ content: "<think>hmm\nlong</think>\nIt fits the purpose." }, "stop") },
        ]);
        const r = await c.judgeIntent(JUDGE);
        expect(r.outcome).toEqual({ kind: "no_tool_call", content: "It fits the purpose." });
        expect(r.record.finishReason).toBe("stop");
    });
});

describe("OpenAiKilnClient — retry policy (D-19, PRD N-05)", () => {
    it("on 429 with x-ratelimit-reset waits that many seconds plus jitter, then succeeds", async () => {
        const { c, sleeps } = client([
            { status: 429, headers: { "x-ratelimit-reset": "3" }, body: { error: { message: "rate" } } },
            { status: 200, body: completion(toolMessage("submit_intent_judgment", "{}")) },
        ]);
        const r = await c.judgeIntent(JUDGE);
        expect(sleeps).toEqual([3500]);
        expect(r.record.attempts).toBe(2);
        expect(r.outcome.kind).toBe("tool_call");
    });

    it("on 429 without the header backs off 1s, 2s, 4s (+jitter) and gives up after 4 attempts with KILN_RATE_LIMITED", async () => {
        const rate = { status: 429, body: { error: { message: "concurrency" } } };
        const { c, sleeps, requests } = client([rate, rate, rate, rate]);
        const r = await c.judgeIntent(JUDGE);
        expect(sleeps).toEqual([1500, 2500, 4500]);
        expect(requests).toHaveLength(4);
        expect(r.outcome).toEqual({ kind: "http_error", status: 429, code: "KILN_RATE_LIMITED" });
        expect(r.record).toMatchObject({ attempts: 4, httpStatus: 429, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });

    it("retries 5xx and network errors with backoff, then succeeds", async () => {
        const { c, sleeps } = client([
            { status: 503, body: { error: { message: "down" } } },
            { throws: new TypeError("fetch failed") },
            { status: 200, body: completion(toolMessage("submit_intent_judgment", "{}")) },
        ]);
        const r = await c.judgeIntent(JUDGE);
        expect(sleeps).toEqual([1500, 2500]);
        expect(r.record.attempts).toBe(3);
        expect(r.outcome.kind).toBe("tool_call");
    });

    it("maps exhausted 5xx to KILN_UNAVAILABLE and caps exponential waits at 8s", async () => {
        const down = { status: 500, body: { error: { message: "x" } } };
        const { c, sleeps } = client([down, down, down, down]);
        const r = await c.judgeIntent(JUDGE);
        expect(r.outcome).toEqual({ kind: "http_error", status: 500, code: "KILN_UNAVAILABLE" });
        expect(Math.max(...sleeps)).toBeLessThanOrEqual(8000 + 1000);
    });

    it("does not retry 402 and reports KILN_CREDIT_EXHAUSTED (keeps the generation id if sent)", async () => {
        const { c, sleeps, requests } = client([
            { status: 402, headers: { "x-neocloud-generation-id": "gen-402" }, body: { error: { message: "credits" } } },
        ]);
        const r = await c.parsePolicy(PARSE);
        expect(requests).toHaveLength(1);
        expect(sleeps).toEqual([]);
        expect(r.outcome).toEqual({ kind: "http_error", status: 402, code: "KILN_CREDIT_EXHAUSTED" });
        expect(r.record).toMatchObject({ attempts: 1, httpStatus: 402, generationId: "gen-402" });
    });

    it("does not retry 400/401/403/404 and maps them to KILN_BAD_REQUEST / KILN_AUTH", async () => {
        for (const [status, code] of [
            [400, "KILN_BAD_REQUEST"],
            [401, "KILN_AUTH"],
            [403, "KILN_AUTH"],
            [404, "KILN_BAD_REQUEST"],
        ] as const) {
            const { c, requests } = client([{ status, body: { error: { message: "no" } } }]);
            const r = await c.judgeIntent(JUDGE);
            expect(requests, String(status)).toHaveLength(1);
            expect(r.outcome, String(status)).toEqual({ kind: "http_error", status, code });
        }
    });

    it("reports a network failure that never recovers as status 0 / KILN_UNAVAILABLE with httpStatus null", async () => {
        const net = { throws: new TypeError("fetch failed") };
        const { c } = client([net, net, net, net]);
        const r = await c.judgeIntent(JUDGE);
        expect(r.outcome).toEqual({ kind: "http_error", status: 0, code: "KILN_UNAVAILABLE" });
        expect(r.record).toMatchObject({ attempts: 4, httpStatus: null });
    });
});
