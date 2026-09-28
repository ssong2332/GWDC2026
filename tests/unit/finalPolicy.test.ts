import { describe, expect, it } from "vitest";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import { validateFinalPolicy } from "@/core/domain/policy";
import type { PolicyValues } from "@/core/domain/types";

// Owner-confirmed final values (Architecture 3 "정책 검증 규칙" — 최종값). now = 1,800,000,000.
const NOW = 1_800_000_000;
const ok: PolicyValues = {
    budget: 200_000n,
    approvalThreshold: 50_000n,
    expiresAt: NOW + 7 * 86_400,
    maxPerMinute: 3,
    maxPerDay: 20,
    merchantIds: ["daiso", "coupang"],
    purpose: "Supplies for the welcome party",
};

describe("validateFinalPolicy", () => {
    it("accepts the demo policy", () => {
        expect(validateFinalPolicy(ok, MERCHANT_REGISTRY, NOW)).toEqual({ ok: true });
    });

    it.each<[string, Partial<PolicyValues>]>([
        ["budget 1 and threshold 0 (lower bounds)", { budget: 1n, approvalThreshold: 0n }],
        ["budget 100,000,000 and threshold = budget (upper bounds)", { budget: 100_000_000n, approvalThreshold: 100_000_000n }],
        ["expiry one second after now", { expiresAt: NOW + 1 }],
        ["perMinute = perDay = 1000", { maxPerMinute: 1000, maxPerDay: 1000 }],
        ["a 200-character purpose", { purpose: "p".repeat(200) }],
    ])("accepts %s", (_label, over) => {
        expect(validateFinalPolicy({ ...ok, ...over }, MERCHANT_REGISTRY, NOW)).toEqual({ ok: true });
    });

    it.each<[string, Partial<PolicyValues>, string]>([
        ["budget 0", { budget: 0n }, "SCHEMA_INVALID"],
        ["budget above 100,000,000", { budget: 100_000_001n }, "SCHEMA_INVALID"],
        ["threshold above budget", { approvalThreshold: 200_001n }, "SCHEMA_INVALID"],
        ["negative threshold", { approvalThreshold: -1n }, "SCHEMA_INVALID"],
        ["missing expiry (0)", { expiresAt: 0 }, "EXPIRY_REQUIRED"],
        ["missing expiry (NaN)", { expiresAt: Number.NaN }, "EXPIRY_REQUIRED"],
        ["expiry equal to now", { expiresAt: NOW }, "SCHEMA_INVALID"],
        ["perMinute 0", { maxPerMinute: 0 }, "SCHEMA_INVALID"],
        ["perMinute above perDay", { maxPerMinute: 21, maxPerDay: 20 }, "SCHEMA_INVALID"],
        ["perDay above 1000", { maxPerMinute: 3, maxPerDay: 1001 }, "SCHEMA_INVALID"],
        ["fractional perDay", { maxPerDay: 2.5 }, "SCHEMA_INVALID"],
        ["blank purpose", { purpose: "   " }, "SCHEMA_INVALID"],
        ["201-character purpose", { purpose: "p".repeat(201) }, "SCHEMA_INVALID"],
        ["no merchants", { merchantIds: [] }, "UNKNOWN_MERCHANT"],
        ["duplicate merchant", { merchantIds: ["daiso", "daiso"] }, "UNKNOWN_MERCHANT"],
        ["merchant not in the registry", { merchantIds: ["daiso", "emart"] }, "UNKNOWN_MERCHANT"],
    ])("rejects %s with %s", (_label, over, code) => {
        const r = validateFinalPolicy({ ...ok, ...over }, MERCHANT_REGISTRY, NOW);
        expect(r).toMatchObject({ ok: false, code });
    });
});
