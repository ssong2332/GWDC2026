import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPublicClient, http } from "viem";
import { rpcErrorInfo } from "@/adapters/chain/readRetry";
import { createViemVaultReader } from "@/adapters/chain/viemVault";
import { DEFAULT_VERIFY_RPC } from "@/config/constants";
import type { EvidenceExport } from "@/core/domain/evidence";
import { AppError } from "@/core/errors";
import { parseEvidenceExport, verifyEvidenceExport, type VerifyReport } from "@/core/usecases/verifyTx";

// Third-party verifier (F-12): needs only the exported JSON and a public RPC — no .env, no SQLite, no operator.
//   npx tsx cli/verify-evidence.ts --file <evidence.json> [--rpc https://sepolia.base.org]
// Exit code 0 when mismatches = 0, otherwise 1. Deliberately imports nothing from cli/_env or cli/_container.

const short = (h: string | null) => (h === null ? "-" : `${h.slice(0, 10)}…${h.slice(-6)}`);

export function formatVerifyReport(file: EvidenceExport, report: VerifyReport): string {
    const head = ["#", "kind", "event", "txHash", "recomputed hash", "on-chain hash", "result"];
    const rows = report.rows.map((r, i) => [
        String(i + 1),
        r.kind,
        r.event ?? "-",
        r.txHash ?? "-",
        short(r.recomputedHash),
        short(r.onchainHash),
        r.result === "OK" ? "OK" : r.problems.map((p) => p.code).join(","),
    ]);
    const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
    const out = [
        `network: ${file.network} (chainId ${file.chainId})  vault: ${file.vault}  records: ${file.records.length}  on-chain events: ${report.onchainEvents}`,
        line(head),
        line(widths.map((w) => "-".repeat(w))),
        ...rows.map(line),
    ];
    for (const p of report.problems) out.push(`  ${p.code}: ${p.detail}${p.txHash ? ` (tx ${p.txHash}${p.logIndex !== undefined ? ` log ${p.logIndex}` : ""})` : ""}`);
    out.push(`mismatches: ${report.mismatches}`);
    return out.join("\n");
}

export async function verifyFile(filePath: string, rpc?: string): Promise<{ file: EvidenceExport; report: VerifyReport }> {
    const file = parseEvidenceExport(JSON.parse(fs.readFileSync(filePath, "utf8")));
    const url = rpc ?? DEFAULT_VERIFY_RPC[file.chainId];
    if (!url) throw new AppError("VALIDATION_FAILED", `no default RPC for chain ${file.chainId} — pass --rpc`);
    const client = createPublicClient({ transport: http(url) });
    const rpcChain = await client.getChainId();
    if (rpcChain !== file.chainId) throw new AppError("CHAIN_MISMATCH", `RPC answers chain ${rpcChain}, the file is for chain ${file.chainId}`);
    const reader = createViemVaultReader({ client, vault: file.vault, chainId: file.chainId });
    return { file, report: await verifyEvidenceExport({ reader }, file) };
}

async function main(): Promise<number> {
    const { values } = parseArgs({ options: { file: { type: "string" }, rpc: { type: "string" } } });
    if (!values.file) throw new AppError("VALIDATION_FAILED", "--file <evidence.json> is required");
    const { file, report } = await verifyFile(path.resolve(values.file), values.rpc);
    console.log(formatVerifyReport(file, report));
    return report.mismatches === 0 ? 0 : 1;
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
    main()
        .then((code) => {
            process.exitCode = code;
        })
        .catch((err: unknown) => {
            const code = err instanceof AppError ? err.code : "INTERNAL";
            const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : String(err)).split("\n")[0];
            console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "verify.failed", code, message, ...rpcErrorInfo(err) }));
            process.exitCode = 1;
        });
}
