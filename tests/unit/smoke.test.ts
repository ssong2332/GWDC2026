import canonicalize from "canonicalize";
import { describe, expect, it } from "vitest";

describe("unit test harness smoke", () => {
    it("runs on Node 22+ with built-in process.loadEnvFile", () => {
        const major = Number(process.versions.node.split(".")[0]);
        expect(major).toBeGreaterThanOrEqual(22);
        expect(typeof process.loadEnvFile).toBe("function");
    });

    it("loads canonicalize (ESM) and produces RFC 8785 key order", () => {
        expect(canonicalize({ b: 1, a: "2", c: [3, { z: null, y: true }] })).toBe(
            '{"a":"2","b":1,"c":[3,{"y":true,"z":null}]}',
        );
    });
});
