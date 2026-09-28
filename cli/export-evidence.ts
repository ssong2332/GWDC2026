import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { NETWORKS, readDeploymentFile, type DeploymentFile, type NetworkName } from "@/adapters/chain/networks";
import { parseServerEnv } from "@/config/env";
import { EVIDENCE_EXPORT_SCHEMA } from "@/config/constants";
import type { EvidenceExport, EvidencePackage, KilnCallExport } from "@/core/domain/evidence";
import type { EvidenceRepo, KilnCallRepo } from "@/core/ports";
import { loadEnvFiles } from "./_env";
import { isEntry, logLine, openRepos, runCli } from "./_container";
import { parseNetwork } from "./deploy";

// Evidence export (F-12, Architecture 5 "내보내기 파일"): SQLite → one JSON file a third party can verify.
//   npx tsx cli/export-evidence.ts --chain localhost|baseSepolia [--db <sqlite>] [--out <file>]

export const EXPORT_FILES: Record<NetworkName, string> = {
    localhost: "data.local/evidence/localhost/evidence.json",
    baseSepolia: "evidence/base-sepolia/evidence.json",
};

function kilnCallIds(pkg: EvidencePackage): string[] {
    if (pkg.kind === "policy_set") return pkg.kiln ? [pkg.kiln.callId] : [];
    if (pkg.kind === "spend_request") return pkg.judgment ? [pkg.judgment.kiln.callId] : [];
    return [];
}

export function buildEvidenceExport(a: { deployment: DeploymentFile; evidence: EvidenceRepo; kilnCalls: KilnCallRepo; now: Date }): EvidenceExport {
    const d = a.deployment;
    const rows = a.evidence.listByVault(d.chainId, d.vault);
    const records = rows.map((r) => ({
        evidenceId: r.evidenceId,
        kind: r.kind,
        evidenceHash: r.evidenceHash,
        package: JSON.parse(r.packageJson) as unknown,
        anchor: r.anchor,
    }));
    const kilnCalls: KilnCallExport[] = [];
    const seen = new Set<string>();
    for (const rec of records)
        for (const id of kilnCallIds(rec.package as EvidencePackage)) {
            if (seen.has(id)) continue;
            seen.add(id);
            const call = a.kilnCalls.findById(id);
            if (!call) continue;
            const { rawArguments: _raw, ...record } = call; // raw arguments already live in the evidence package
            kilnCalls.push(record);
        }
    return {
        schema: EVIDENCE_EXPORT_SCHEMA,
        network: d.network,
        chainId: d.chainId,
        vault: d.vault,
        token: d.token,
        deployBlock: String(d.deployBlock),
        exportedAt: a.now.toISOString(),
        records,
        kilnCalls,
    };
}

export function writeEvidenceExport(file: string, exp: EvidenceExport): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(exp, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { chain: { type: "string" }, db: { type: "string" }, out: { type: "string" } } });
    loadEnvFiles(); // only DATABASE_PATH is needed — no wallet variables
    const env = parseServerEnv({ ...process.env, ...(values.chain ? { CHAIN: values.chain } : {}) });
    const network = parseNetwork(values.chain, env.chain);
    const deployment = readDeploymentFile(path.resolve(NETWORKS[network].deploymentFile));
    const repos = openRepos(values.db ?? env.databasePath);
    try {
        const exp = buildEvidenceExport({ deployment, evidence: repos.evidence, kilnCalls: repos.kilnCalls, now: new Date() });
        const file = path.resolve(values.out ?? EXPORT_FILES[network]);
        writeEvidenceExport(file, exp);
        const unanchored = exp.records.filter((r) => r.anchor === null).length;
        logLine("info", "evidence.exported", { network, vault: deployment.vault, records: exp.records.length, unanchored, kilnCalls: exp.kilnCalls.length, file: path.relative(process.cwd(), file) });
    } finally {
        repos.db.close();
    }
}

if (isEntry(import.meta.url)) runCli(main);
