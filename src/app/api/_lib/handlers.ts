import type { z } from "zod";
import { AppError } from "@/core/errors";
import { buildEfficiencyReport } from "@/core/usecases/buildEfficiencyReport";
import { buildReceipt } from "@/core/usecases/buildReceipt";
import { confirmOwnerAction } from "@/core/usecases/confirmOwnerAction";
import { listActivity } from "@/core/usecases/listActivity";
import { parsePolicy } from "@/core/usecases/parsePolicy";
import { prepareOwnerAction } from "@/core/usecases/prepareOwnerAction";
import { syncChainEvents } from "@/core/usecases/syncChainEvents";
import { verifyTx } from "@/core/usecases/verifyTx";
import type { AppContainer } from "@/server/container";
import { confirmBodySchema, parseBodySchema, prepareBodySchema, requestIdSchema, txHashSchema, type KilnUsageDto } from "./dto";
import { errorResponse, failure, jsonOk, readJsonBody } from "./http";

// Route Handler bodies (Architecture 9): input validation → use case → DTO (bigint → string) → error mapping.
// The route.ts files only pass the container in; tests call these directly with their own container.

function validated<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
    const r = schema.safeParse(value);
    if (!r.success) {
        const issue = r.error.issues[0];
        throw new AppError("VALIDATION_FAILED", `${issue.path.join(".") || "body"}: ${issue.message}`);
    }
    return r.data;
}

async function guarded(fn: () => Promise<Response>): Promise<Response> {
    try {
        return await fn();
    } catch (err) {
        return errorResponse(err);
    }
}

const ctx = (c: AppContainer) => ({ chainId: c.chainId, vault: c.vault });
const syncDeps = (c: AppContainer) => ({ ...ctx(c), reader: c.reader, chainEvents: c.chainEvents, evidence: c.evidence, deployBlock: c.deployBlock });

export function handleParsePolicy(c: AppContainer, req: Request): Promise<Response> {
    return guarded(async () => {
        const body = validated(parseBodySchema, await readJsonBody(req));
        const r = await parsePolicy({ ...ctx(c), kiln: c.kiln, kilnCalls: c.kilnCalls, merchants: c.merchants, clock: c.clock }, body);
        if (!r.ok) return failure(r.code, r.message);
        const call = c.kilnCalls.findById(r.parseCallId);
        const usage: KilnUsageDto | null = call && {
            promptTokens: call.promptTokens,
            completionTokens: call.completionTokens,
            reasoningTokens: call.reasoningTokens,
            totalTokens: call.totalTokens,
            costUsd: call.costUsd,
            generationId: call.generationId,
            provider: call.provider,
        };
        return jsonOk({ parseCallId: r.parseCallId, candidate: r.candidate, warnings: r.warnings, usage });
    });
}

export function handlePrepareOwnerAction(c: AppContainer, req: Request): Promise<Response> {
    return guarded(async () => {
        const input = validated(prepareBodySchema, await readJsonBody(req));
        const out = await prepareOwnerAction(
            { ...ctx(c), vaultOwner: c.owner, feeBps: c.feeBps, evidence: c.evidence, kilnCalls: c.kilnCalls, merchants: c.merchants, clock: c.clock },
            input,
        );
        return jsonOk({ ...out, vault: c.vault, chainId: c.chainId });
    });
}

export function handleConfirmOwnerAction(c: AppContainer, req: Request): Promise<Response> {
    return guarded(async () => {
        const input = validated(confirmBodySchema, await readJsonBody(req));
        const out = await confirmOwnerAction({ ...syncDeps(c), ...c.confirm }, input);
        return jsonOk({ status: out.status, events: out.events });
    });
}

export function handleVaultState(c: AppContainer): Promise<Response> {
    return guarded(async () => {
        const { chainId: _chainId, vault: _vault, ...state } = await c.reader.getState();
        return jsonOk({
            chainId: c.chainId,
            vault: c.vault,
            token: c.token,
            owner: c.owner,
            agent: c.agent,
            feeBps: c.feeBps,
            explorerTxUrl: c.explorerTxUrl,
            state,
        });
    });
}

export function handleVaultActivity(c: AppContainer): Promise<Response> {
    return guarded(async () => {
        await syncChainEvents(syncDeps(c));
        return jsonOk({ items: listActivity({ ...ctx(c), chainEvents: c.chainEvents, evidence: c.evidence, merchants: c.merchants }) });
    });
}

export function handleReceipt(c: AppContainer, requestId: string): Promise<Response> {
    return guarded(async () => {
        const id = validated(requestIdSchema, requestId);
        await syncChainEvents(syncDeps(c));
        const receipt = await buildReceipt({ ...ctx(c), chainEvents: c.chainEvents, evidence: c.evidence, merchants: c.merchants }, id);
        if (!receipt) throw new AppError("NOT_FOUND", "no executed payment for this request");
        return jsonOk({ receipt });
    });
}

export function handleAudit(c: AppContainer, txHash: string): Promise<Response> {
    return guarded(async () => {
        const hash = validated(txHashSchema, txHash);
        await syncChainEvents(syncDeps(c));
        const result = await verifyTx({ ...ctx(c), reader: c.reader, evidence: c.evidence, chainEvents: c.chainEvents }, hash);
        return jsonOk({ result });
    });
}

export function handleEfficiency(c: AppContainer): Promise<Response> {
    return guarded(async () => jsonOk({ report: await buildEfficiencyReport({ ...ctx(c), kilnCalls: c.kilnCalls, spendRequests: c.spendRequests }) }));
}
