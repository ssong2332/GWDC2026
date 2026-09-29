import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatEfficiencyReport, reportFromFile } from "../../cli/report-efficiency";

// `npm run report:efficiency -- --file <evidence.json>`: the per-flow table for the README, from the exported file only.

describe("report:efficiency CLI", () => {
    it("Base Sepolia evidence → kiln provider, three flow rows, totals and the not-measured note", () => {
        const report = reportFromFile(path.resolve("evidence/base-sepolia/evidence.json"));
        expect(report.provider).toBe("kiln");
        const text = formatEfficiencyReport(report);
        const lines = text.split("\n");
        expect(lines.find((l) => l.startsWith("| policy_parse"))).toContain("| 1075 |");
        expect(lines.find((l) => l.startsWith("| rule_block"))).toMatch(/^\| rule_block \| 0 \| 3 \| 0 \| 0 \| 0 \| 0 \|/);
        expect(lines.find((l) => l.startsWith("| total"))).toContain(`| ${report.totals.totalTokens} |`);
        expect(text).toMatch(/not measured/i);
        expect(text).toContain("3600");
    });

    it("energy labels (D-38) → 2-card scenario header and savings line, card count not confirmable, no upper bound", () => {
        const text = formatEfficiencyReport(reportFromFile(path.resolve("evidence/base-sepolia/evidence.json")));
        const lines = text.split("\n");
        expect(lines.find((l) => l.startsWith("| flow"))).toMatch(/\| energy est\., 2-card scenario \(Wh\) \|$/);
        expect(lines.find((l) => l.startsWith("Rule-blocked requests:"))).toMatch(/Wh \(2-card scenario\)\.$/);
        expect(lines.find((l) => l.startsWith("Energy:"))).toContain("2-card scenario estimate");
        expect(text).toContain("card count cannot be confirmed");
        expect(text).not.toMatch(/upper bound/i);
        expect(text).not.toContain("≤");
    });

    it("missing or invalid file → throws with the reason", () => {
        expect(() => reportFromFile(path.resolve("evidence/does-not-exist.json"))).toThrow();
        expect(() => reportFromFile(path.resolve("package.json"))).toThrow(/evidence file/);
    });
});
