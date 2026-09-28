import type { Jsonify } from "@/app/api/_lib/dto";
import { DEFAULT_RATE_LIMITS, POLICY_RULES } from "@/config/constants";
import { expiresOnToUnix } from "@/core/domain/policy";
import type { Hex, PolicyCandidate } from "@/core/domain/types";
import type { ApiError } from "../apiClient";

// Delegate screen state (Architecture 10 위임 화면 상태, PRD 화면 ①, F-01 ④⑤, D-22):
// empty → parsing → parsed(candidate, warnings) | parse_error(code) → registered(txHash). Signing itself is the
// owner-action state machine; this reducer only holds the sentence, the Kiln candidate and the owner's form.

export type CandidateDto = Jsonify<PolicyCandidate>;

export type PolicyForm = {
    budget: string;
    approvalThreshold: string;
    merchantIds: string[];
    /** YYYY-MM-DD (Asia/Seoul day, expires 23:59:59 KST). Empty when the sentence had no expiry (F-01 ⑤). */
    expiresOn: string;
    purpose: string;
    maxPerMinute: string;
    maxPerDay: string;
};

export type DelegateState = {
    phase: "empty" | "parsing" | "parsed" | "parse_error" | "registered";
    text: string;
    parseCallId: string | null;
    candidate: CandidateDto | null;
    warnings: string[];
    form: PolicyForm | null;
    error: ApiError | null;
    txHash: Hex | null;
};

export type DelegateAction =
    | { type: "text_changed"; text: string }
    | { type: "parse_started" }
    | { type: "parse_succeeded"; parseCallId: string; candidate: CandidateDto; warnings: string[] }
    | { type: "parse_failed"; error: ApiError }
    | { type: "form_changed"; patch: Partial<PolicyForm> }
    | { type: "registered"; txHash: Hex }
    | { type: "reset" };

export const initialDelegateState: DelegateState = {
    phase: "empty",
    text: "",
    parseCallId: null,
    candidate: null,
    warnings: [],
    form: null,
    error: null,
    txHash: null,
};

export function formFromCandidate(c: CandidateDto): PolicyForm {
    return {
        budget: c.budget,
        approvalThreshold: c.approvalThreshold,
        merchantIds: [...c.merchantIds],
        expiresOn: c.expiresOn ?? "",
        purpose: c.purpose,
        maxPerMinute: String(DEFAULT_RATE_LIMITS.maxPerMinute),
        maxPerDay: String(DEFAULT_RATE_LIMITS.maxPerDay),
    };
}

export function delegateReducer(s: DelegateState, a: DelegateAction): DelegateState {
    switch (a.type) {
        case "text_changed":
            // A candidate belongs to the sentence it was parsed from (the evidence stores both), so editing drops it.
            return { ...initialDelegateState, text: a.text };
        case "parse_started":
            return { ...s, phase: "parsing", error: null, candidate: null, form: null, parseCallId: null, warnings: [] };
        case "parse_succeeded":
            return { ...s, phase: "parsed", parseCallId: a.parseCallId, candidate: a.candidate, warnings: a.warnings, form: formFromCandidate(a.candidate), error: null };
        case "parse_failed":
            return { ...s, phase: "parse_error", error: a.error, candidate: null, form: null, parseCallId: null, warnings: [] };
        case "form_changed":
            return s.phase === "parsed" && s.form ? { ...s, form: { ...s.form, ...a.patch } } : s;
        case "registered":
            return { ...s, phase: "registered", txHash: a.txHash };
        case "reset":
            return initialDelegateState;
    }
}

export type FormErrors = Partial<Record<keyof PolicyForm, string>>;

export type PolicySetBody = {
    kind: "policy_set";
    owner: Hex;
    parseCallId: string | null;
    delegationText: string;
    final: {
        budget: string;
        approvalThreshold: string;
        expiresAt: number;
        maxPerMinute: number;
        maxPerDay: number;
        merchantIds: string[];
        purpose: string;
    };
    expiresAtSource: "kiln" | "owner";
    ownerEdits: string[];
};

const INT_RE = /^\d{1,15}$/;
const toInt = (s: string): number | null => (INT_RE.test(s.trim()) ? Number(s.trim()) : null);

/** Owner-side checks mirroring the server's final-value rules (the server re-validates; this gives field-level feedback). */
function validateForm(f: PolicyForm, nowSec: number): { errors: FormErrors; expiresAt: number | null } {
    const errors: FormErrors = {};
    const budget = toInt(f.budget);
    if (budget === null || budget < POLICY_RULES.budgetMin || budget > POLICY_RULES.budgetMax)
        errors.budget = `Enter a whole number of KRW between ${POLICY_RULES.budgetMin} and ${POLICY_RULES.budgetMax.toLocaleString("en-US")}`;
    const threshold = toInt(f.approvalThreshold);
    if (threshold === null || (budget !== null && threshold > budget)) errors.approvalThreshold = "Enter a whole number of KRW between 0 and the budget";
    if (f.merchantIds.length < POLICY_RULES.merchantsMin || f.merchantIds.length > POLICY_RULES.merchantsMax)
        errors.merchantIds = "Select at least one merchant";
    let expiresAt: number | null = null;
    if (f.expiresOn.trim() === "") errors.expiresOn = "Enter an expiry date";
    else {
        expiresAt = expiresOnToUnix(f.expiresOn.trim());
        if (expiresAt === null) errors.expiresOn = "Enter a valid date (YYYY-MM-DD)";
        else if (expiresAt <= nowSec) errors.expiresOn = "The expiry date must be today or later";
    }
    const purpose = f.purpose.trim();
    if (purpose.length === 0 || f.purpose.length > POLICY_RULES.purposeMax) errors.purpose = `Enter a purpose (1–${POLICY_RULES.purposeMax} characters)`;
    const perMinute = toInt(f.maxPerMinute);
    const perDay = toInt(f.maxPerDay);
    if (perDay === null || perDay < 1 || perDay > POLICY_RULES.rateLimitMax) errors.maxPerDay = `Enter 1–${POLICY_RULES.rateLimitMax}`;
    if (perMinute === null || perMinute < 1 || (perDay !== null && perMinute > perDay)) errors.maxPerMinute = "Enter at least 1 and no more than the daily limit";
    return { errors, expiresAt };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export function buildPolicySetBody(i: {
    form: PolicyForm;
    candidate: CandidateDto;
    parseCallId: string | null;
    delegationText: string;
    owner: Hex;
    nowSec: number;
}): { ok: true; body: PolicySetBody } | { ok: false; errors: FormErrors } {
    const { form: f, candidate: c } = i;
    const { errors, expiresAt } = validateForm(f, i.nowSec);
    if (Object.keys(errors).length > 0 || expiresAt === null) return { ok: false, errors };
    const expiresOn = f.expiresOn.trim();
    const edits: [string, boolean][] = [
        ["budget", BigInt(f.budget.trim()) !== BigInt(c.budget)],
        ["approvalThreshold", BigInt(f.approvalThreshold.trim()) !== BigInt(c.approvalThreshold)],
        ["merchantIds", !sameSet(f.merchantIds, c.merchantIds)],
        ["expiresAt", c.expiresOn !== expiresOn],
        ["purpose", f.purpose.trim() !== c.purpose],
    ];
    return {
        ok: true,
        body: {
            kind: "policy_set",
            owner: i.owner,
            parseCallId: i.parseCallId,
            delegationText: i.delegationText,
            final: {
                budget: BigInt(f.budget.trim()).toString(),
                approvalThreshold: BigInt(f.approvalThreshold.trim()).toString(),
                expiresAt,
                maxPerMinute: Number(f.maxPerMinute.trim()),
                maxPerDay: Number(f.maxPerDay.trim()),
                merchantIds: [...f.merchantIds],
                purpose: f.purpose.trim(),
            },
            expiresAtSource: c.expiresOn !== null && c.expiresOn === expiresOn ? "kiln" : "owner",
            ownerEdits: edits.filter(([, changed]) => changed).map(([name]) => name),
        },
    };
}
