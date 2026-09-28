import type { KilnRef } from "@/core/domain/evidence";
import type { Hex } from "@/core/domain/types";
import type { KilnCallRepo, KilnCallResult } from "@/core/ports";

/** Stores one Kiln call (success or failure) with its flow label, usage and Generation-Id (F-14 usage). */
export function saveKilnCall(
    repo: KilnCallRepo,
    result: KilnCallResult,
    ctx: { chainId: number; vault: Hex; requestId: Hex | null },
): void {
    const o = result.outcome;
    repo.insert({
        ...result.record,
        ...ctx,
        status: o.kind,
        errorCode: o.kind === "http_error" ? o.code : null,
        rawArguments: o.kind === "tool_call" ? o.rawArguments : null,
        rawContent: o.kind === "no_tool_call" ? o.content : null,
    });
}

export function toKilnRef(result: KilnCallResult): KilnRef {
    const r = result.record;
    return {
        callId: r.callId,
        provider: r.provider,
        model: r.model,
        generationId: r.generationId,
        finishReason: r.finishReason,
        usage: {
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            reasoningTokens: r.reasoningTokens,
            totalTokens: r.totalTokens,
            costUsd: r.costUsd,
        },
        rawArguments: result.outcome.kind === "tool_call" ? result.outcome.rawArguments : null,
    };
}
