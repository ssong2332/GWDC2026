import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard (T-04): `npm --prefix chain install` added the root package to chain/ as "gwdc2026": "file:..",
// making chain/node_modules/gwdc2026 a link back to the repo root (recursive paths, "Filename too long" in git).

const chainDir = path.resolve(__dirname, "../../chain");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(chainDir, f), "utf8"));

describe("chain/ package manifests", () => {
    it("chain/package.json has no local file: / link: dependencies (in particular not the root package)", () => {
        const pkg = read("package.json");
        const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
        expect(Object.entries(deps).filter(([, spec]) => /^(file|link):/.test(spec))).toEqual([]);
        expect(deps).not.toHaveProperty("gwdc2026");
    });

    it("chain/package-lock.json does not link the repo root into chain/node_modules", () => {
        const lock = read("package-lock.json");
        expect(Object.keys(lock.packages)).not.toContain("..");
        expect(Object.keys(lock.packages)).not.toContain("node_modules/gwdc2026");
    });
});
