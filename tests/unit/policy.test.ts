import { describe, expect, it } from "vitest";
import { expiresOnToUnix, kstDate, validatePolicyArgs } from "@/core/domain/policy";
import { MERCHANT_REGISTRY } from "@/config/merchants";

const DEMO_ARGS = {
    total_budget_krw: 200000,
    approval_threshold_krw: 50000,
    allowed_merchant_ids: ["daiso", "coupang"],
    unrecognized_merchants: [],
    expires_on: null,
    purpose: "Supplies for the student club event",
};

const run = (args: unknown) => validatePolicyArgs(JSON.stringify(args), MERCHANT_REGISTRY);

describe("validatePolicyArgs — Kiln submit_spending_policy arguments (Architecture 정책 검증 규칙)", () => {
    it("F-01 ①: accepts the demo sentence's arguments and converts amounts to bigint", () => {
        expect(run(DEMO_ARGS)).toEqual({
            ok: true,
            candidate: {
                budget: 200_000n,
                approvalThreshold: 50_000n,
                merchantIds: ["daiso", "coupang"],
                expiresOn: null,
                purpose: "Supplies for the student club event",
                unrecognizedMerchants: [],
            },
            warnings: [],
        });
    });

    it("F-01 ④: keeps a stated deadline as YYYY-MM-DD", () => {
        const r = run({ ...DEMO_ARGS, expires_on: "2026-10-05" });
        expect(r.ok && r.candidate.expiresOn).toBe("2026-10-05");
    });

    it("accepts the budget boundaries 1 and 100,000,000 and threshold 0 / threshold == budget", () => {
        expect(run({ ...DEMO_ARGS, total_budget_krw: 1, approval_threshold_krw: 0 }).ok).toBe(true);
        expect(run({ ...DEMO_ARGS, total_budget_krw: 100_000_000, approval_threshold_krw: 100_000_000 }).ok).toBe(
            true,
        );
    });

    it("rejects budget 0, budget above 100,000,000, non-integers and threshold > budget with SCHEMA_INVALID", () => {
        for (const bad of [
            { total_budget_krw: 0 },
            { total_budget_krw: 100_000_001 },
            { total_budget_krw: 1000.5 },
            { total_budget_krw: "200000" },
            { approval_threshold_krw: -1 },
            { approval_threshold_krw: 200_001 },
            { purpose: "" },
            { purpose: "x".repeat(201) },
            { expires_on: "2026-02-30" },
            { expires_on: "10/05/2026" },
        ]) {
            const r = run({ ...DEMO_ARGS, ...bad });
            expect(r, JSON.stringify(bad)).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
        }
    });

    it("rejects a missing required field (expires_on must be present, null allowed) with SCHEMA_INVALID", () => {
        const { expires_on: _omit, ...withoutExpiry } = DEMO_ARGS;
        expect(run(withoutExpiry)).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
    });

    it("rejects merchant ids that are unknown, duplicated, empty or more than 20 with UNKNOWN_MERCHANT", () => {
        for (const ids of [["daiso", "emart"], ["daiso", "daiso"], [], Array(21).fill("daiso")]) {
            expect(run({ ...DEMO_ARGS, allowed_merchant_ids: ids }), JSON.stringify(ids)).toMatchObject({
                ok: false,
                code: "UNKNOWN_MERCHANT",
            });
        }
    });

    it("rejects text that is not a JSON object with INVALID_ARGS", () => {
        for (const raw of ["", "not json", "[1,2]", "null", '{"total_budget_krw": 1'])
            expect(validatePolicyArgs(raw, MERCHANT_REGISTRY), raw).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    });

    it("turns unrecognized merchant names into warnings, not errors", () => {
        const r = run({ ...DEMO_ARGS, unrecognized_merchants: ["이마트"] });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.candidate.unrecognizedMerchants).toEqual(["이마트"]);
            expect(r.warnings).toEqual(["Merchant not in registry, excluded from the policy: 이마트"]);
        }
    });
});

describe("expiresOnToUnix — date → 23:59:59 Asia/Seoul (D-22)", () => {
    it("converts 2026-10-05 to 2026-10-05T14:59:59Z", () => {
        expect(expiresOnToUnix("2026-10-05")).toBe(Date.UTC(2026, 9, 5, 14, 59, 59) / 1000);
    });

    it("handles the year boundary and a leap day", () => {
        expect(expiresOnToUnix("2026-12-31")).toBe(Date.UTC(2026, 11, 31, 14, 59, 59) / 1000);
        expect(expiresOnToUnix("2028-02-29")).toBe(Date.UTC(2028, 1, 29, 14, 59, 59) / 1000);
    });

    it("returns null for impossible or malformed dates", () => {
        expect(expiresOnToUnix("2026-02-29")).toBeNull();
        expect(expiresOnToUnix("2026-13-01")).toBeNull();
        expect(expiresOnToUnix("")).toBeNull();
    });
});

describe("kstDate — today in Asia/Seoul as YYYY-MM-DD", () => {
    it("rolls over at 15:00 UTC (00:00 KST)", () => {
        expect(kstDate(new Date("2026-09-28T14:59:59Z"))).toBe("2026-09-28");
        expect(kstDate(new Date("2026-09-28T15:00:00Z"))).toBe("2026-09-29");
    });
});
