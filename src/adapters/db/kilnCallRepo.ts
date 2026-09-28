import type Database from "better-sqlite3";
import { KILN } from "@/config/constants";
import type { KilnCallRecord, KilnCallRepo } from "@/core/ports";

type Row = {
    call_id: string;
    flow: KilnCallRecord["flow"];
    provider: KilnCallRecord["provider"];
    model: string;
    http_status: number | null;
    finish_reason: string | null;
    attempts: number;
    latency_ms: number;
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens: number | null;
    total_tokens: number;
    cached_tokens: number | null;
    cost_usd: string | null;
    generation_id: string | null;
    thinking_mode: KilnCallRecord["thinkingMode"];
    created_at: string;
};

export function createKilnCallRepo(db: Database.Database): KilnCallRepo {
    const insert = db.prepare(
        `INSERT INTO kiln_calls (call_id, flow, provider, chain_id, vault, request_id, model, status, http_status, error_code,
           finish_reason, attempts, latency_ms, prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, cached_tokens,
           cost_usd, generation_id, thinking_mode, raw_arguments, raw_content, created_at)
         VALUES (@callId, @flow, @provider, @chainId, @vault, @requestId, @model, @status, @httpStatus, @errorCode,
           @finishReason, @attempts, @latencyMs, @promptTokens, @completionTokens, @reasoningTokens, @totalTokens, @cachedTokens,
           @costUsd, @generationId, @thinkingMode, @rawArguments, @rawContent, @createdAt)`,
    );
    const byId = db.prepare("SELECT * FROM kiln_calls WHERE call_id = ?");
    return {
        insert: (r) =>
            void insert.run({ ...r, rawContent: r.rawContent === null ? null : r.rawContent.slice(0, KILN.rawContentMax) }),
        findById: (id) => {
            const r = byId.get(id) as Row | undefined;
            if (!r) return null;
            return {
                callId: r.call_id,
                flow: r.flow,
                provider: r.provider,
                model: r.model,
                httpStatus: r.http_status,
                finishReason: r.finish_reason,
                attempts: r.attempts,
                latencyMs: r.latency_ms,
                promptTokens: r.prompt_tokens,
                completionTokens: r.completion_tokens,
                reasoningTokens: r.reasoning_tokens,
                totalTokens: r.total_tokens,
                cachedTokens: r.cached_tokens,
                costUsd: r.cost_usd,
                generationId: r.generation_id,
                thinkingMode: r.thinking_mode,
                createdAt: r.created_at,
            };
        },
    };
}
