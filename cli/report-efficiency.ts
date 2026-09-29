import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { aggregateCalls, composeEfficiencyReport, requestFlowCounts, type EfficiencyReport } from "@/core/domain/efficiency";
import { AppError } from "@/core/errors";
import { parseEvidenceExport } from "@/core/usecases/verifyTx";

// F-14 per-flow efficiency table (Markdown) from an exported evidence file — no .env, no SQLite, no RPC.
//   npm run report:efficiency -- --file evidence/base-sepolia/evidence.json
// Same computation as the ④ Efficiency screen (core/domain/efficiency), fed by the file's kilnCalls and records.

export function reportFromFile(filePath: string): EfficiencyReport {
    const file = parseEvidenceExport(JSON.parse(fs.readFileSync(filePath, "utf8")));
    const provider = file.kilnCalls.some((c) => c.provider === "kiln") ? "kiln" : "fake";
    return composeEfficiencyReport(provider, aggregateCalls(file.kilnCalls, provider), requestFlowCounts(file.records));
}

const wh = (n: number) => n.toFixed(4);

export function formatEfficiencyReport(r: EfficiencyReport): string {
    const head = "| flow | Kiln calls | requests | prompt | completion | reasoning | total tokens | cost (USD) | energy est., 2-card scenario (Wh) |";
    const rows = r.rows.map(
        (x) =>
            `| ${x.flow} | ${x.kilnCalls} | ${x.requests} | ${x.promptTokens} | ${x.completionTokens} | ${x.reasoningTokens ?? "-"} | ${x.totalTokens} | ${x.costUsd} | ${wh(x.energyWhUpper)} |`,
    );
    const t = r.totals;
    const out = [
        `provider: ${r.provider}${r.provider === "fake" ? " (simulated — fake Kiln data)" : ""}`,
        "",
        head,
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
        ...rows,
        `| total | ${t.kilnCalls} | - | ${t.promptTokens} | ${t.completionTokens} | ${t.reasoningTokens ?? "-"} | ${t.totalTokens} | ${t.costUsd} | ${wh(t.energyWhUpper)} |`,
        "",
        `Rule-blocked requests: ${r.savings.ruleBlockedRequests} (0 Kiln calls). Avoided (estimate from the intent_judge average): ~${r.savings.avoidedTokensEstimate} tokens, ~${wh(r.savings.avoidedEnergyWhUpper)} Wh (2-card scenario).`,
        `Energy: ${r.energy.formula}`,
        ...r.energy.assumptions.map((a) => `  - ${a.name} = ${a.value} ${a.unit} — ${a.source}`),
        r.energy.disclaimer,
    ];
    return out.join("\n");
}

function main(): number {
    const { values } = parseArgs({ options: { file: { type: "string" } } });
    if (!values.file) throw new AppError("VALIDATION_FAILED", "--file <evidence.json> is required");
    console.log(formatEfficiencyReport(reportFromFile(path.resolve(values.file))));
    return 0;
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
    try {
        process.exitCode = main();
    } catch (err: unknown) {
        const code = err instanceof AppError ? err.code : "INTERNAL";
        const message = (err instanceof Error ? err.message : String(err)).split("\n")[0];
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "report.failed", code, message }));
        process.exitCode = 1;
    }
}
