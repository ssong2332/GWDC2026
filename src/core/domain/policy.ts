import { z } from "zod";
import { KST_OFFSET_SECONDS, POLICY_RULES, SECONDS_PER_DAY } from "@/config/constants";
import type { MerchantEntry, PolicyCandidate } from "./types";

export type PolicyArgsCode = "INVALID_ARGS" | "SCHEMA_INVALID" | "UNKNOWN_MERCHANT";

export type PolicyArgsResult =
    | { ok: true; candidate: PolicyCandidate; warnings: string[] }
    | { ok: false; code: PolicyArgsCode; message: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dateParts(date: string): [number, number, number] | null {
    const m = DATE_RE.exec(date);
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
    return [y, mo, d];
}

/** YYYY-MM-DD → unix seconds of that day's 23:59:59 in Asia/Seoul (D-22). null if not a real date. */
export function expiresOnToUnix(date: string): number | null {
    const p = dateParts(date);
    if (!p) return null;
    const utcMidnight = Date.UTC(p[0], p[1] - 1, p[2]) / 1000;
    return utcMidnight + SECONDS_PER_DAY - 1 - KST_OFFSET_SECONDS;
}

/** Today's calendar date in Asia/Seoul. */
export function kstDate(now: Date): string {
    return new Date(now.getTime() + KST_OFFSET_SECONDS * 1000).toISOString().slice(0, 10);
}

// Kiln `submit_spending_policy` arguments. Field ranges from Architecture 3 "정책 검증 규칙".
const policyArgsSchema = z
    .object({
        total_budget_krw: z.number().int().min(POLICY_RULES.budgetMin).max(POLICY_RULES.budgetMax),
        approval_threshold_krw: z.number().int().min(0),
        allowed_merchant_ids: z.array(z.string()),
        unrecognized_merchants: z.array(z.string()).optional(),
        expires_on: z
            .string()
            .refine((d) => dateParts(d) !== null, "expires_on must be a real YYYY-MM-DD date")
            .nullable(),
        purpose: z.string().trim().min(1).max(POLICY_RULES.purposeMax),
    })
    .refine((a) => a.approval_threshold_krw <= a.total_budget_krw, {
        message: "approval_threshold_krw must not exceed total_budget_krw",
        path: ["approval_threshold_krw"],
    });

function merchantProblem(ids: string[], registry: MerchantEntry[]): string | null {
    if (ids.length < POLICY_RULES.merchantsMin || ids.length > POLICY_RULES.merchantsMax)
        return `allowed_merchant_ids must have ${POLICY_RULES.merchantsMin}..${POLICY_RULES.merchantsMax} entries`;
    if (new Set(ids).size !== ids.length) return "allowed_merchant_ids has duplicates";
    const known = new Set(registry.map((m) => m.id));
    const unknown = ids.filter((id) => !known.has(id));
    return unknown.length ? `unknown merchant ids: ${unknown.join(", ")}` : null;
}

/**
 * Validates the raw tool-call arguments from Kiln (F-01 ②). Nothing becomes a policy candidate
 * unless every rule passes. Failure codes: INVALID_ARGS (not a JSON object), SCHEMA_INVALID (field
 * types/ranges), UNKNOWN_MERCHANT (merchant list rules).
 */
export function validatePolicyArgs(rawArguments: string, registry: MerchantEntry[]): PolicyArgsResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawArguments);
    } catch {
        return { ok: false, code: "INVALID_ARGS", message: "Kiln arguments are not valid JSON" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return { ok: false, code: "INVALID_ARGS", message: "Kiln arguments are not a JSON object" };

    const r = policyArgsSchema.safeParse(parsed);
    if (!r.success) {
        const issue = r.error.issues[0];
        return { ok: false, code: "SCHEMA_INVALID", message: `${issue.path.join(".") || "arguments"}: ${issue.message}` };
    }
    const a = r.data;
    const problem = merchantProblem(a.allowed_merchant_ids, registry);
    if (problem) return { ok: false, code: "UNKNOWN_MERCHANT", message: problem };

    const unrecognized = a.unrecognized_merchants ?? [];
    return {
        ok: true,
        candidate: {
            budget: BigInt(a.total_budget_krw),
            approvalThreshold: BigInt(a.approval_threshold_krw),
            merchantIds: a.allowed_merchant_ids,
            expiresOn: a.expires_on,
            purpose: a.purpose,
            unrecognizedMerchants: unrecognized,
        },
        warnings: unrecognized.map((name) => `Merchant not in registry, excluded from the policy: ${name}`),
    };
}
