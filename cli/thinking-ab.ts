import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { OpenAiKilnClient } from "@/adapters/kiln/openaiKilnClient";
import type { JudgeInput, ThinkingMode } from "@/adapters/kiln/types";
import { parseServerEnv } from "@/config/env";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import { interpretIntentOutcome } from "@/core/domain/intent";
import { AppError } from "@/core/errors";
import type { KilnClient } from "@/core/ports";
import { loadEnvFiles } from "./_env";

// T-11 / F-16: thinking mode A/B on the intent_judge flow (PRD OQ #17 — same request × 3 modes × 3 runs = 9 Kiln calls).
//   npm run measure:thinking            (real Kiln — KILN_API_KEY from .env, loaded at runtime by this process)
// Hard cap: at most 9 real HTTP requests. Any failure (non-2xx or network error) halts the run — no retries,
// no extra calls to make up the count. Only the mode rows, token counts, latency, Generation-Id and the judgment
// are written; the API key, base URL and env values never go to the file, stdout or the log lines.

export const THINKING_MODES: readonly ThinkingMode[] = ["default", "kwargs_off", "no_think"];
export const RUNS_PER_MODE = 3;
export const AB_SCHEMA = "thinking-ab/v1";

const daiso = MERCHANT_REGISTRY.find((m) => m.id === "daiso");
if (!daiso) throw new Error("merchant registry has no daiso entry");

/** The demo scenario's representative purchase (e2e step 2 — executed on Base Sepolia with this exact judge input). */
export const AB_JUDGE_INPUT: JudgeInput = {
    purpose: "Event expenses",
    delegationText: "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐",
    merchantName: daiso.displayName,
    amount: 30_000n,
    itemDescription: "Balloons and table decorations for the welcome party",
};

export type AbSample = {
    mode: ThinkingMode;
    run: number;
    httpStatus: number | null;
    attempts: number;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number | null;
    totalTokens: number;
    cachedTokens: number | null;
    costUsd: string | null;
    finishReason: string | null;
    generationId: string | null;
    /** interpretIntentOutcome status: match | mismatch | invalid_output | error */
    judgment: string;
    reason: string;
};

export type ModeSummary = {
    mode: ThinkingMode;
    runs: number;
    /** samples with a 2xx response — only these enter the averages */
    ok: number;
    avgPromptTokens: number | null;
    avgCompletionTokens: number | null;
    avgReasoningTokens: number | null;
    avgTotalTokens: number | null;
    avgLatencyMs: number | null;
    judgments: string[];
    /** % reduction vs the default mode's average (negative = increase); null for the default row itself */
    reasoningSavingsPct: number | null;
    completionSavingsPct: number | null;
    totalSavingsPct: number | null;
    latencySavingsPct: number | null;
};

export type AbSummary = { modes: ModeSummary[]; judgmentsAgree: boolean };

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Reduction of `value` vs `base` in %, rounded to 0.1. null when either side is missing or base is 0. */
export function savingsPct(base: number | null, value: number | null): number | null {
    if (base === null || value === null || base === 0) return null;
    return round1(((base - value) / base) * 100);
}

const isCount = (n: number) => Number.isInteger(n) && n >= 0;

function assertSample(s: AbSample): void {
    if (!THINKING_MODES.includes(s.mode)) throw new RangeError(`unknown thinking mode: ${String(s.mode)}`);
    for (const [k, v] of [
        ["promptTokens", s.promptTokens],
        ["completionTokens", s.completionTokens],
        ["totalTokens", s.totalTokens],
        ["reasoningTokens", s.reasoningTokens ?? 0],
    ] as const)
        if (!isCount(v)) throw new RangeError(`${k} must be a non-negative integer, got ${v}`);
    if (!(Number.isFinite(s.latencyMs) && s.latencyMs >= 0)) throw new RangeError(`latencyMs must be >= 0, got ${s.latencyMs}`);
}

const isOk = (s: AbSample) => s.httpStatus !== null && s.httpStatus >= 200 && s.httpStatus < 300;

function avg(values: number[]): number | null {
    return values.length === 0 ? null : round1(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Per-mode averages (2xx samples only), savings vs default, and whether every answered judgment is the same. */
export function summarizeAb(samples: AbSample[]): AbSummary {
    if (samples.length === 0) throw new RangeError("no samples to summarize");
    samples.forEach(assertSample);

    const rows = THINKING_MODES.filter((m) => samples.some((s) => s.mode === m)).map((mode) => {
        const all = samples.filter((s) => s.mode === mode);
        const ok = all.filter(isOk);
        const reasoning = ok.map((s) => s.reasoningTokens).filter((v): v is number => v !== null);
        return {
            mode,
            runs: all.length,
            ok: ok.length,
            avgPromptTokens: avg(ok.map((s) => s.promptTokens)),
            avgCompletionTokens: avg(ok.map((s) => s.completionTokens)),
            avgReasoningTokens: avg(reasoning),
            avgTotalTokens: avg(ok.map((s) => s.totalTokens)),
            avgLatencyMs: avg(ok.map((s) => s.latencyMs)),
            judgments: all.map((s) => s.judgment),
        };
    });
    const base = rows.find((r) => r.mode === "default");
    const vs = (pick: (r: (typeof rows)[number]) => number | null, r: (typeof rows)[number]) =>
        r.mode === "default" || !base ? null : savingsPct(pick(base), pick(r));
    const modes: ModeSummary[] = rows.map((r) => ({
        ...r,
        reasoningSavingsPct: vs((x) => x.avgReasoningTokens, r),
        completionSavingsPct: vs((x) => x.avgCompletionTokens, r),
        totalSavingsPct: vs((x) => x.avgTotalTokens, r),
        latencySavingsPct: vs((x) => x.avgLatencyMs, r),
    }));
    const answered = samples.filter(isOk).map((s) => s.judgment);
    return { modes, judgmentsAgree: answered.length > 0 && answered.every((j) => j === answered[0]) };
}

const cell = (n: number | null) => (n === null ? "-" : String(n));
const pct = (n: number | null, isBase: boolean) => (isBase ? "baseline" : n === null ? "-" : `${n}%`);

export function formatAbMarkdown(s: AbSummary): string {
    const head =
        "| mode | runs (ok) | avg prompt | avg completion | avg reasoning | avg total | avg latency (ms) | reasoning saved | completion saved | total saved | latency saved | judgments |";
    const rows = s.modes.map((m) => {
        const b = m.mode === "default";
        return `| ${m.mode} | ${m.runs} (${m.ok}) | ${cell(m.avgPromptTokens)} | ${cell(m.avgCompletionTokens)} | ${cell(m.avgReasoningTokens)} | ${cell(m.avgTotalTokens)} | ${cell(m.avgLatencyMs)} | ${pct(m.reasoningSavingsPct, b)} | ${pct(m.completionSavingsPct, b)} | ${pct(m.totalSavingsPct, b)} | ${pct(m.latencySavingsPct, b)} | ${m.judgments.join(", ")} |`;
    });
    return [
        head,
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
        ...rows,
        "",
        "Saved = reduction of the mode's average vs the default mode's average (negative = increase). Averages use 2xx responses only.",
        `Judgments agree across modes: ${s.judgmentsAgree ? "YES" : "NO"}`,
    ].join("\n");
}

type Halt = { status: number; message: string };

/**
 * Wraps fetch with a hard cap on real HTTP requests. After the first non-2xx response or network error every later
 * request is refused before it reaches the network, so the Kiln client's own retries cannot add calls.
 */
export function createRequestGuard(limit: number, inner: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
    let sent = 0;
    let halt: Halt | null = null;
    const guarded = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (halt) throw new Error(`request guard halted after ${halt.message} — no further requests`);
        if (sent >= limit) throw new Error(`request budget of ${limit} exhausted — no further requests`);
        sent++;
        let res: Response;
        try {
            res = await inner(url, init);
        } catch (err) {
            halt = { status: 0, message: (err instanceof Error ? err.message : String(err)).split("\n")[0] };
            throw err;
        }
        if (res.status < 200 || res.status >= 300) halt = { status: res.status, message: `HTTP ${res.status}` };
        return res;
    };
    return { fetch: guarded, sent: () => sent, halt: () => halt };
}

export type Stopped = { mode: ThinkingMode; run: number; httpStatus: number; code: string; message: string };

export type MeasureOptions = {
    apiKey: string;
    baseURL: string;
    model: string;
    maxTokensJudge: number;
    outDir: string;
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
    log?: (line: string) => void;
};

export type MeasureResult = {
    filePath: string;
    summary: AbSummary | null;
    markdown: string;
    stopped: Stopped | null;
    httpRequests: number;
};

function toSample(mode: ThinkingMode, run: number, r: Awaited<ReturnType<KilnClient["judgeIntent"]>>): AbSample {
    const j = interpretIntentOutcome(r.outcome, r.record.callId);
    const rec = r.record;
    return {
        mode,
        run,
        httpStatus: rec.httpStatus,
        attempts: rec.attempts,
        latencyMs: rec.latencyMs,
        promptTokens: rec.promptTokens,
        completionTokens: rec.completionTokens,
        reasoningTokens: rec.reasoningTokens,
        totalTokens: rec.totalTokens,
        cachedTokens: rec.cachedTokens,
        costUsd: rec.costUsd,
        finishReason: rec.finishReason,
        generationId: rec.generationId,
        judgment: j.status,
        reason: j.reason,
    };
}

/** Runs the A/B (round-robin: run 1 = default, kwargs_off, no_think, then run 2, …), saves the raw JSON, returns the table. */
export async function measureThinkingAb(o: MeasureOptions): Promise<MeasureResult> {
    const now = o.now ?? (() => new Date());
    const log = o.log ?? ((line: string) => console.log(line));
    const logJson = (event: string, fields: Record<string, unknown>) =>
        log(JSON.stringify({ ts: now().toISOString(), level: "info", event, ...fields }));
    const budget = THINKING_MODES.length * RUNS_PER_MODE;
    const guard = createRequestGuard(budget, o.fetch ?? globalThis.fetch);
    const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const client = (mode: ThinkingMode) =>
        new OpenAiKilnClient({
            apiKey: o.apiKey,
            baseURL: o.baseURL,
            body: { model: o.model, maxTokensParse: o.maxTokensJudge, maxTokensJudge: o.maxTokensJudge, thinkingMode: mode },
            fetch: guard.fetch as typeof globalThis.fetch,
            // After a halt the client's retry loop only meets the guard's refusal — skip its backoff waits.
            sleep: (ms) => (guard.halt() ? Promise.resolve() : realSleep(ms)),
            now,
        });
    const clients = new Map(THINKING_MODES.map((m) => [m, client(m)] as const));

    const startedAt = now().toISOString();
    const samples: AbSample[] = [];
    let stopped: Stopped | null = null;
    outer: for (let run = 1; run <= RUNS_PER_MODE; run++) {
        for (const mode of THINKING_MODES) {
            const r = await clients.get(mode)!.judgeIntent(AB_JUDGE_INPUT);
            const s = toSample(mode, run, r);
            samples.push(s);
            logJson("thinking_ab.call", {
                mode,
                run,
                httpStatus: s.httpStatus,
                promptTokens: s.promptTokens,
                completionTokens: s.completionTokens,
                reasoningTokens: s.reasoningTokens,
                totalTokens: s.totalTokens,
                latencyMs: s.latencyMs,
                generationId: s.generationId,
                judgment: s.judgment,
            });
            if (r.outcome.kind === "http_error") {
                const h = guard.halt();
                stopped = { mode, run, httpStatus: h?.status ?? r.outcome.status, code: r.outcome.code ?? "KILN_ERROR", message: h?.message ?? "request failed" };
                break outer;
            }
        }
    }
    const finishedAt = now().toISOString();

    const summary = samples.length > 0 ? summarizeAb(samples) : null;
    const markdown = summary ? formatAbMarkdown(summary) : "(no samples)";
    fs.mkdirSync(o.outDir, { recursive: true });
    const filePath = path.join(o.outDir, `thinking-ab-${startedAt.replace(/[:.]/g, "-")}.json`);
    const file = {
        schema: AB_SCHEMA,
        task: "T-11",
        flow: "intent_judge",
        model: o.model,
        maxTokensJudge: o.maxTokensJudge,
        modes: THINKING_MODES,
        runsPerMode: RUNS_PER_MODE,
        order: "round-robin (run 1: default, kwargs_off, no_think; then run 2, run 3)",
        httpRequestBudget: budget,
        httpRequestsSent: guard.sent(),
        retryPolicy: "none — the first failed request halts the run",
        startedAt,
        finishedAt,
        input: { ...AB_JUDGE_INPUT, amount: AB_JUDGE_INPUT.amount.toString() },
        stopped,
        samples,
        summary,
    };
    fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    return { filePath, summary, markdown, stopped, httpRequests: guard.sent() };
}

async function main(): Promise<number> {
    const { values } = parseArgs({ options: { out: { type: "string" } } });
    // Only .env (the Kiln variables live there, .env.example) — wallet keys in .env.cli are not needed here.
    loadEnvFiles({ files: [".env"] });
    const env = parseServerEnv({ ...process.env, KILN_MODE: "real" });
    if (!env.kiln.apiKey) throw new AppError("ENV_INVALID", "KILN_API_KEY is required");
    const r = await measureThinkingAb({
        apiKey: env.kiln.apiKey,
        baseURL: env.kiln.baseUrl,
        model: env.kiln.model,
        maxTokensJudge: env.kiln.maxTokensJudge,
        outDir: path.resolve(values.out ?? "evidence/thinking-ab"),
    });
    console.log(`\nThinking mode A/B — intent_judge, model ${env.kiln.model}, ${r.httpRequests} HTTP requests`);
    console.log(r.markdown);
    console.log(`\nraw: ${path.relative(process.cwd(), r.filePath)}`);
    if (r.stopped) {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "thinking_ab.stopped", ...r.stopped }));
        return 1;
    }
    return 0;
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
    main().then(
        (code) => {
            process.exitCode = code;
        },
        (err: unknown) => {
            const code = err instanceof AppError ? err.code : "INTERNAL";
            const message = (err instanceof Error ? err.message : String(err)).split("\n")[0];
            console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "thinking_ab.failed", code, message }));
            process.exitCode = 1;
        },
    );
}
