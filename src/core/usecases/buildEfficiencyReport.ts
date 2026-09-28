import { composeEfficiencyReport, type EfficiencyReport } from "@/core/domain/efficiency";
import type { Hex } from "@/core/domain/types";
import type { KilnCallRepo, SpendRequestRepo } from "@/core/ports";

// F-14 ④ efficiency report from SQLite. Real Kiln rows and fake-Kiln rows are never mixed (Architecture 4
// FakeKilnClient): the report uses the real rows when this vault has any, otherwise the fake rows (UI shows a banner).

export type BuildEfficiencyDeps = { chainId: number; vault: Hex; kilnCalls: KilnCallRepo; spendRequests: SpendRequestRepo };

export async function buildEfficiencyReport(d: BuildEfficiencyDeps): Promise<EfficiencyReport> {
    const real = d.kilnCalls.aggregateByFlow(d.chainId, d.vault, "kiln");
    const provider = real.length > 0 ? "kiln" : "fake";
    const rows = provider === "kiln" ? real : d.kilnCalls.aggregateByFlow(d.chainId, d.vault, "fake");
    return composeEfficiencyReport(provider, rows, d.spendRequests.countByFlow(d.chainId, d.vault));
}
