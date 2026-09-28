import type Database from "better-sqlite3";
import { KILN } from "@/config/constants";
import type { FlowAggregate } from "@/core/domain/efficiency";
import type { KilnCallRecord, KilnCallRepo } from "@/core/ports";

type AggregateRow = { flow: FlowAggregate["flow"]; n: number; p: number; c: number; t: number; r: number | null; cost: number; latency: number };

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
    raw_arguments: string | null;
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
    // One GROUP BY per flow (D-33). String(TOTAL(...)) keeps the cost as the architecture's decimal string.
    const aggregate = db.prepare(
        `SELECT flow, COUNT(*) AS n, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, SUM(total_tokens) AS t,
           SUM(reasoning_tokens) AS r, TOTAL(CAST(cost_usd AS REAL)) AS cost, SUM(latency_ms) AS latency
         FROM kiln_calls WHERE chain_id = ? AND vault = ? AND provider = ? GROUP BY flow
         ORDER BY CASE flow WHEN 'policy_parse' THEN 0 ELSE 1 END`,
    );
    const generationIds = db.prepare(
        `SELECT flow, generation_id FROM kiln_calls
         WHERE chain_id = ? AND vault = ? AND provider = ? AND generation_id IS NOT NULL ORDER BY created_at, rowid`,
    );
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
                rawArguments: r.raw_arguments,
            };
        },
        aggregateByFlow: (chainId, vault, provider) => {
            const ids = generationIds.all(chainId, vault, provider) as { flow: string; generation_id: string }[];
            return (aggregate.all(chainId, vault, provider) as AggregateRow[]).map((a) => ({
                flow: a.flow,
                kilnCalls: a.n,
                promptTokens: a.p,
                completionTokens: a.c,
                totalTokens: a.t,
                reasoningTokens: a.r,
                costUsd: String(a.cost),
                latencyMsSum: a.latency,
                generationIds: ids.filter((i) => i.flow === a.flow).map((i) => i.generation_id),
            }));
        },
    };
}
