import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// F-17 ④, D-41 (Architecture "UI 언어 테스트" ⑬): the API, the core and the CLI never see the UI language —
// no import of src/ui/i18n and no cookie reads — so language cannot reach request bodies, evidence, hashes or txs.

const ROOT = join(__dirname, "..", "..");
const DIRS = ["src/app/api", "src/core", "cli"];

function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return name === "node_modules" ? [] : tsFiles(p);
        return /\.tsx?$/.test(name) ? [p] : [];
    });
}

describe("UI language stays out of API / core / CLI", () => {
    const files = DIRS.flatMap((d) => tsFiles(join(ROOT, d)));

    it("finds the files it guards", () => {
        expect(files.length).toBeGreaterThan(20);
        expect(files.some((f) => f.includes("handlers.ts"))).toBe(true);
    });

    it.each(DIRS)("%s: no ui/i18n import and no cookies( call", (dir) => {
        const offenders = files
            .filter((f) => f.startsWith(join(ROOT, dir)))
            .filter((f) => {
                const src = readFileSync(f, "utf8");
                return /ui\/i18n/.test(src) || /cookies\(/.test(src);
            });
        expect(offenders).toEqual([]);
    });
});
