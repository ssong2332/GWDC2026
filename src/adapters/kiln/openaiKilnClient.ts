import OpenAI, { APIError } from "openai";
import { KILN } from "@/config/constants";
import type { KilnFlow, KilnOutcome } from "@/core/domain/types";
import type { KilnCallRecord, KilnCallResult, KilnClient } from "@/core/ports";
import { buildChatBody } from "./requestBody";
import { errorCodeFor, isRetryable, retryDelayMs } from "./retryPolicy";
import { stripThink } from "./thinkStrip";
import type { ChatBody, JudgeInput, KilnBodyConfig, ParseInput } from "./types";

export type OpenAiKilnClientOptions = {
    apiKey: string;
    baseURL: string;
    body: KilnBodyConfig;
    fetch?: typeof globalThis.fetch;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    now?: () => Date;
};

type Usage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number | null } | null;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
    cost?: number | string | null;
};

/**
 * Kiln (OpenAI-compatible) client. Sends, retries and records usage only — argument validation is the
 * use case's job. The SDK's own retries are off so every attempt and wait is ours to count (D-19).
 * Never throws for HTTP or network failures: they come back as an `http_error` outcome with a record.
 */
export class OpenAiKilnClient implements KilnClient {
    private readonly openai: OpenAI;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly random: () => number;
    private readonly now: () => Date;

    constructor(private readonly opts: OpenAiKilnClientOptions) {
        this.openai = new OpenAI({
            apiKey: opts.apiKey,
            baseURL: opts.baseURL,
            maxRetries: 0,
            timeout: KILN.timeoutMs,
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
        });
        this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.random = opts.random ?? Math.random;
        this.now = opts.now ?? (() => new Date());
    }

    parsePolicy(i: ParseInput): Promise<KilnCallResult> {
        return this.call("policy_parse", buildChatBody("policy_parse", i, this.opts.body));
    }

    judgeIntent(i: JudgeInput): Promise<KilnCallResult> {
        return this.call("intent_judge", buildChatBody("intent_judge", i, this.opts.body));
    }

    private async call(flow: KilnFlow, body: ChatBody): Promise<KilnCallResult> {
        const base = {
            callId: crypto.randomUUID(),
            flow,
            provider: "kiln" as const,
            model: body.model,
            thinkingMode: this.opts.body.thinkingMode,
            createdAt: this.now().toISOString(),
        };
        for (let attempt = 1; ; attempt++) {
            const started = performance.now();
            try {
                const { data, response } = await this.openai.chat.completions
                    .create(body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming)
                    .withResponse();
                const choice = data.choices[0];
                const usage = (data.usage ?? {}) as Usage;
                const record: KilnCallRecord = {
                    ...base,
                    httpStatus: response.status,
                    finishReason: choice?.finish_reason ?? null,
                    attempts: attempt,
                    latencyMs: Math.round(performance.now() - started),
                    promptTokens: usage.prompt_tokens ?? 0,
                    completionTokens: usage.completion_tokens ?? 0,
                    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
                    totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
                    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
                    costUsd: usage.cost === undefined || usage.cost === null ? null : String(usage.cost),
                    generationId: response.headers.get(KILN.generationIdHeader),
                };
                return { record, outcome: outcomeOf(choice?.message) };
            } catch (err) {
                const latencyMs = Math.round(performance.now() - started);
                const status = err instanceof APIError && typeof err.status === "number" ? err.status : 0;
                const headers = err instanceof APIError ? err.headers : undefined;
                if (isRetryable(status) && attempt < KILN.maxAttempts) {
                    await this.sleep(
                        retryDelayMs(attempt, status, headers?.get(KILN.rateLimitResetHeader) ?? null, this.random),
                    );
                    continue;
                }
                const record: KilnCallRecord = {
                    ...base,
                    httpStatus: status === 0 ? null : status,
                    finishReason: null,
                    attempts: attempt,
                    latencyMs,
                    promptTokens: 0,
                    completionTokens: 0,
                    reasoningTokens: null,
                    totalTokens: 0,
                    cachedTokens: null,
                    costUsd: null,
                    generationId: headers?.get(KILN.generationIdHeader) ?? null,
                };
                return { record, outcome: { kind: "http_error", status, code: errorCodeFor(status) } };
            }
        }
    }
}

function outcomeOf(message: OpenAI.Chat.ChatCompletionMessage | undefined): KilnOutcome {
    const call = message?.tool_calls?.[0];
    if (call && call.type === "function")
        return { kind: "tool_call", functionName: call.function.name, rawArguments: call.function.arguments };
    return { kind: "no_tool_call", content: stripThink(message?.content ?? "") };
}
