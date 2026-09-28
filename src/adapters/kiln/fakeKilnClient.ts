import { FAKE_INTENT_MISMATCH_PATTERN, KILN, KILN_FUNCTION_NAMES } from "@/config/constants";
import type { KilnFlow, KilnOutcome } from "@/core/domain/types";
import type { KilnCallRecord, KilnCallResult, KilnClient } from "@/core/ports";
import { errorCodeFor } from "./retryPolicy";
import { stripThink } from "./thinkStrip";
import type { JudgeInput, ParseInput } from "./types";

// Stand-in for Kiln while no team key exists (KILN_MODE=fake). Records provider "fake" so the
// efficiency report never mixes simulated usage with measured usage.

export type FakeReply = {
    toolCall?: { name: string; arguments: unknown };
    content?: string;
    httpError?: number;
    usage?: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number | null; costUsd?: string | null };
    generationId?: string | null;
};
export type FakeCall = { kind: "policy_parse"; input: ParseInput } | { kind: "intent_judge"; input: JudgeInput };
export type FakeHandler = (call: FakeCall) => FakeReply;

/** Test handler: answers calls in order from a fixed script. */
export function queueHandler(replies: FakeReply[]): FakeHandler {
    const queue = [...replies];
    return (call) => {
        const next = queue.shift();
        if (!next) throw new Error(`FakeKilnClient: no scripted reply left for ${call.kind}`);
        return next;
    };
}

const MAN_WON = /(\d+)\s*만\s*원/g;

function fakeParse(input: ParseInput): FakeReply {
    const text = input.delegationText;
    let budget: number | null = null;
    let threshold: number | null = null;
    for (const m of text.matchAll(MAN_WON)) {
        const krw = Number(m[1]) * 10_000;
        const before = text.slice(Math.max(0, (m.index ?? 0) - 4), m.index);
        if (before.includes("건당")) threshold ??= krw;
        else budget ??= krw;
    }
    const lower = text.toLowerCase();
    const merchantIds = input.merchants
        .filter((m) => m.aliases.some((a) => lower.includes(a.toLowerCase())))
        .map((m) => m.id);
    return {
        toolCall: {
            name: KILN_FUNCTION_NAMES.policy,
            arguments: {
                total_budget_krw: budget ?? 0,
                approval_threshold_krw: threshold ?? budget ?? 0,
                allowed_merchant_ids: merchantIds,
                unrecognized_merchants: [],
                expires_on: /\d{4}-\d{2}-\d{2}/.exec(text)?.[0] ?? null,
                purpose: "Event expenses delegated by the owner (simulated Kiln)",
            },
        },
        usage: { promptTokens: 0, completionTokens: 0 },
    };
}

/** Deterministic handler for E2E and UI development (Architecture 4, FakeKilnClient). */
export const defaultFakeHandler: FakeHandler = (call) => {
    if (call.kind === "policy_parse") return fakeParse(call.input);
    const mismatch = FAKE_INTENT_MISMATCH_PATTERN.test(call.input.itemDescription);
    return {
        toolCall: {
            name: KILN_FUNCTION_NAMES.intent,
            arguments: {
                fits_purpose: !mismatch,
                reason: mismatch
                    ? "The item looks like a personal purchase, not the delegated purpose (simulated Kiln)."
                    : "The item plausibly serves the delegated purpose (simulated Kiln).",
            },
        },
        usage: { promptTokens: 0, completionTokens: 0 },
    };
};

export class FakeKilnClient implements KilnClient {
    readonly calls: FakeCall[] = [];

    constructor(
        private readonly handler: FakeHandler,
        private readonly model: string = KILN.defaultModel,
    ) {}

    async parsePolicy(input: ParseInput): Promise<KilnCallResult> {
        return this.answer({ kind: "policy_parse", input });
    }

    async judgeIntent(input: JudgeInput): Promise<KilnCallResult> {
        return this.answer({ kind: "intent_judge", input });
    }

    private answer(call: FakeCall): KilnCallResult {
        this.calls.push(call);
        const reply = this.handler(call);
        return { record: this.record(call.kind, reply), outcome: outcomeOf(reply) };
    }

    private record(flow: KilnFlow, reply: FakeReply): KilnCallRecord {
        const failed = reply.httpError !== undefined;
        const prompt = failed ? 0 : (reply.usage?.promptTokens ?? 0);
        const completion = failed ? 0 : (reply.usage?.completionTokens ?? 0);
        return {
            callId: crypto.randomUUID(),
            flow,
            provider: "fake",
            model: this.model,
            httpStatus: reply.httpError ?? 200,
            finishReason: failed ? null : reply.toolCall ? "tool_calls" : "stop",
            attempts: 1,
            latencyMs: 0,
            promptTokens: prompt,
            completionTokens: completion,
            reasoningTokens: failed ? null : (reply.usage?.reasoningTokens ?? null),
            totalTokens: prompt + completion,
            cachedTokens: null,
            costUsd: failed ? null : (reply.usage?.costUsd ?? null),
            generationId: reply.generationId ?? null,
            thinkingMode: "default",
            createdAt: new Date().toISOString(),
        };
    }
}

function outcomeOf(reply: FakeReply): KilnOutcome {
    if (reply.httpError !== undefined)
        return { kind: "http_error", status: reply.httpError, code: errorCodeFor(reply.httpError) };
    if (reply.toolCall)
        return {
            kind: "tool_call",
            functionName: reply.toolCall.name,
            rawArguments:
                typeof reply.toolCall.arguments === "string"
                    ? reply.toolCall.arguments
                    : JSON.stringify(reply.toolCall.arguments),
        };
    return { kind: "no_tool_call", content: stripThink(reply.content ?? "") };
}
