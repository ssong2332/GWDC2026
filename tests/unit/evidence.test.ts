import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonical, hashPackage } from "@/core/domain/evidence";

// Reference values computed once with js-sha3 (chain/node_modules), an implementation independent of viem.
const VECTOR_CANONICAL = '{"amount":"30000","kind":"spend_request","nested":{"a":null,"b":true},"text":"풍선"}';
const VECTOR_HASH = "0xf627d405e963dc97c37e79ad203b23b3a1aa1e3c4dfc2f4ce62588ff7aa2c411";

describe("evidence canonicalization + keccak256 (D-13, RFC 8785)", () => {
    it("produces the fixed canonical string and hash for a known package regardless of key order", () => {
        const pkg = { text: "풍선", nested: { b: true, a: null }, kind: "spend_request", amount: "30000" };
        expect(canonicalJson(pkg)).toBe(VECTOR_CANONICAL);
        expect(hashPackage(pkg)).toEqual({ canonical: VECTOR_CANONICAL, hash: VECTOR_HASH });
    });

    it("hashes the empty string to the well-known keccak256 value", () => {
        expect(hashCanonical("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    });

    it("changes the hash when a single character of the package changes", () => {
        const a = hashPackage({ amount: "30000" }).hash;
        const b = hashPackage({ amount: "30001" }).hash;
        expect(a).not.toBe(b);
    });

    it("refuses values JCS cannot represent the same way everywhere (bigint, undefined, functions)", () => {
        expect(() => canonicalJson({ amount: 1n })).toThrow(TypeError);
        expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
        expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
        expect(() => canonicalJson(undefined)).toThrow(TypeError);
    });
});
