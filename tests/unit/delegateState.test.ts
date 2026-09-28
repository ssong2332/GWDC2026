import { describe, expect, it } from "vitest";
import { expiresOnToUnix } from "@/core/domain/policy";
import {
    buildPolicySetBody,
    delegateReducer,
    formFromCandidate,
    initialDelegateState,
    type CandidateDto,
    type DelegateState,
    type PolicyForm,
} from "@/ui/delegate/delegateState";

// Delegate screen state machine (Architecture 10 위임 화면 상태, PRD 화면 ①, F-01 ④⑤, D-22):
// empty → parsing → parsed(candidate, warnings) | parse_error(code) → registered(txHash).

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const TEXT = "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐";
const NOW = Math.floor(new Date("2026-09-28T03:00:00Z").getTime() / 1000);

const candidate = (over: Partial<CandidateDto> = {}): CandidateDto => ({
    budget: "200000",
    approvalThreshold: "50000",
    merchantIds: ["daiso", "coupang"],
    expiresOn: null,
    purpose: "Event expenses",
    unrecognizedMerchants: [],
    ...over,
});

function parsedState(c = candidate()): DelegateState {
    let s = delegateReducer(initialDelegateState, { type: "text_changed", text: TEXT });
    s = delegateReducer(s, { type: "parse_started" });
    return delegateReducer(s, { type: "parse_succeeded", parseCallId: "call-1", candidate: c, warnings: [] });
}

describe("delegateReducer", () => {
    it("starts empty: no text, no candidate (빈 값 — policy not shown)", () => {
        expect(initialDelegateState).toMatchObject({ phase: "empty", text: "", candidate: null, form: null });
    });

    it("parsing → parsed keeps the candidate and a form filled from it", () => {
        const s = parsedState();
        expect(s.phase).toBe("parsed");
        expect(s.parseCallId).toBe("call-1");
        expect(s.form).toEqual(formFromCandidate(candidate()));
    });

    it("parse failure → parse_error with the code; no candidate is kept (F-01 ②)", () => {
        let s = delegateReducer(initialDelegateState, { type: "text_changed", text: "Buy snacks" });
        s = delegateReducer(s, { type: "parse_started" });
        s = delegateReducer(s, { type: "parse_failed", error: { code: "SCHEMA_INVALID", message: "total_budget_krw: too small" } });
        expect(s).toMatchObject({ phase: "parse_error", candidate: null, form: null, error: { code: "SCHEMA_INVALID" } });
    });

    it("editing the sentence after a parse discards the candidate (evidence ties text to the parse call)", () => {
        const s = delegateReducer(parsedState(), { type: "text_changed", text: `${TEXT}!` });
        expect(s).toMatchObject({ phase: "empty", candidate: null, form: null, parseCallId: null, text: `${TEXT}!` });
    });

    it("form edits only apply in the parsed phase", () => {
        const s = delegateReducer(parsedState(), { type: "form_changed", patch: { expiresOn: "2026-10-05" } });
        expect(s.form?.expiresOn).toBe("2026-10-05");
        expect(delegateReducer(initialDelegateState, { type: "form_changed", patch: { expiresOn: "2026-10-05" } })).toBe(initialDelegateState);
    });

    it("registered keeps the tx hash", () => {
        const tx = `0x${"44".repeat(32)}` as const;
        expect(delegateReducer(parsedState(), { type: "registered", txHash: tx })).toMatchObject({ phase: "registered", txHash: tx });
    });
});

describe("formFromCandidate (F-01 ④⑤)", () => {
    it("expiry from Kiln fills the field", () => {
        expect(formFromCandidate(candidate({ expiresOn: "2026-10-05" })).expiresOn).toBe("2026-10-05");
    });

    it("no expiry in the sentence → empty field for the owner to fill", () => {
        expect(formFromCandidate(candidate()).expiresOn).toBe("");
    });

    it("burst limits default to the constants (not extracted by Kiln, D-07)", () => {
        const f = formFromCandidate(candidate());
        expect(f).toMatchObject({ budget: "200000", approvalThreshold: "50000", maxPerMinute: "3", maxPerDay: "20", merchantIds: ["daiso", "coupang"] });
    });
});

describe("buildPolicySetBody — confirmed form → /api/owner-actions/prepare body", () => {
    const build = (form: PolicyForm, c = candidate()) =>
        buildPolicySetBody({ form, candidate: c, parseCallId: "call-1", delegationText: TEXT, owner: OWNER, nowSec: NOW });

    it("owner-entered expiry: KST 23:59:59 of that date, source owner, recorded as an edit", () => {
        const r = build({ ...formFromCandidate(candidate()), expiresOn: "2026-10-05" });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.body).toEqual({
            kind: "policy_set",
            owner: OWNER,
            parseCallId: "call-1",
            delegationText: TEXT,
            final: {
                budget: "200000",
                approvalThreshold: "50000",
                expiresAt: expiresOnToUnix("2026-10-05"),
                maxPerMinute: 3,
                maxPerDay: 20,
                merchantIds: ["daiso", "coupang"],
                purpose: "Event expenses",
            },
            expiresAtSource: "owner",
            ownerEdits: ["expiresAt"],
        });
    });

    it("Kiln expiry kept unchanged → source kiln, no edits", () => {
        const c = candidate({ expiresOn: "2026-10-05" });
        const r = build(formFromCandidate(c), c);
        expect(r.ok && r.body.expiresAtSource).toBe("kiln");
        expect(r.ok && r.body.ownerEdits).toEqual([]);
    });

    it("Kiln expiry changed by the owner → source owner", () => {
        const c = candidate({ expiresOn: "2026-10-05" });
        const r = build({ ...formFromCandidate(c), expiresOn: "2026-10-06" }, c);
        expect(r.ok && r.body.expiresAtSource).toBe("owner");
        expect(r.ok && r.body.ownerEdits).toEqual(["expiresAt"]);
    });

    it("lists every field the owner changed (merchant order does not count as a change)", () => {
        const f = formFromCandidate(candidate({ expiresOn: "2026-10-05" }));
        const r = build(
            { ...f, budget: "150000", approvalThreshold: "40000", merchantIds: ["coupang"], purpose: "Snacks" },
            candidate({ expiresOn: "2026-10-05" }),
        );
        expect(r.ok && r.body.ownerEdits).toEqual(["budget", "approvalThreshold", "merchantIds", "purpose"]);
        const same = build({ ...f, merchantIds: ["coupang", "daiso"] }, candidate({ expiresOn: "2026-10-05" }));
        expect(same.ok && same.body.ownerEdits).toEqual([]);
    });

    it("missing expiry → field error, no body (EXPIRY_REQUIRED on the form)", () => {
        const r = build(formFromCandidate(candidate()));
        expect(r).toEqual({ ok: false, errors: { expiresOn: "Enter an expiry date" } });
    });

    it.each([
        ["expiry today already past 23:59:59 KST? no — yesterday", { expiresOn: "2026-09-27" }, "expiresOn"],
        ["impossible date", { expiresOn: "2026-02-30" }, "expiresOn"],
        ["budget 0", { budget: "0" }, "budget"],
        ["budget above 100,000,000", { budget: "100000001" }, "budget"],
        ["budget not an integer", { budget: "12.5" }, "budget"],
        ["threshold above budget", { approvalThreshold: "300000" }, "approvalThreshold"],
        ["no merchant", { merchantIds: [] }, "merchantIds"],
        ["empty purpose", { purpose: "   " }, "purpose"],
        ["per-minute above per-day", { maxPerMinute: "30", maxPerDay: "20" }, "maxPerMinute"],
        ["per-minute 0", { maxPerMinute: "0" }, "maxPerMinute"],
        ["per-day above 1000", { maxPerDay: "1001" }, "maxPerDay"],
    ])("rejects %s", (_n, patch, field) => {
        const r = build({ ...formFromCandidate(candidate()), expiresOn: "2026-10-05", ...patch } as PolicyForm);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(Object.keys(r.errors)).toContain(field);
    });

    it("boundary: threshold equal to budget and threshold 0 are allowed", () => {
        const base = { ...formFromCandidate(candidate()), expiresOn: "2026-10-05" };
        expect(build({ ...base, approvalThreshold: "200000" }).ok).toBe(true);
        expect(build({ ...base, approvalThreshold: "0" }).ok).toBe(true);
    });

    it("boundary: expiry today (23:59:59 KST still ahead) is allowed", () => {
        expect(build({ ...formFromCandidate(candidate()), expiresOn: "2026-09-28" }).ok).toBe(true);
    });
});
