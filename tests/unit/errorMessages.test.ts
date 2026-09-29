import { describe, expect, it } from "vitest";
import { en } from "@/ui/i18n/en";
import { ko } from "@/ui/i18n/ko";
import { ERROR_MESSAGES, describeError } from "@/ui/errorMessages";
import { API_CODES, CLIENT_CODES, CONTRACT_CODES } from "./helpers/errorCodes";

// src/ui/errorMessages.ts (Architecture 에러 처리): code → text for API and wallet errors alike.
// T-17 (F-17 ⑥⑧, D-41): the title comes from the selected dictionary (describeError(e, m)); ERROR_MESSAGES is the
// English dictionary kept as the client-side ApiError.message diagnostic value.

describe("ERROR_MESSAGES (= en.errors)", () => {
    it("is the English dictionary table", () => {
        expect(ERROR_MESSAGES).toBe(en.errors);
    });

    it.each([...API_CODES, ...CLIENT_CODES, ...CONTRACT_CODES])("has an English message for %s", (code) => {
        const text = ERROR_MESSAGES[code];
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(5);
        expect(text).not.toMatch(/[ㄱ-힝]/); // the en dictionary is English (Korean lives in ko.errors)
    });

    it("signature rejection reads exactly as the design says", () => {
        expect(ERROR_MESSAGES.SIGNATURE_REJECTED).toBe("Signature rejected");
    });
});

describe("describeError", () => {
    it("known code → table text as title, server message as detail", () => {
        expect(describeError({ code: "KILN_CREDIT_EXHAUSTED", message: "Kiln request failed (HTTP 402)" }, en)).toEqual({
            title: ERROR_MESSAGES.KILN_CREDIT_EXHAUSTED,
            detail: "Kiln request failed (HTTP 402)",
        });
    });

    it("ko → Korean title, the server message stays in its original English", () => {
        expect(describeError({ code: "KILN_CREDIT_EXHAUSTED", message: "Kiln request failed (HTTP 402)" }, ko)).toEqual({
            title: ko.errors.KILN_CREDIT_EXHAUSTED,
            detail: "Kiln request failed (HTTP 402)",
        });
    });

    it("unknown code → generic title and the code in the detail", () => {
        const d = describeError({ code: "SOMETHING_NEW", message: "" }, ko);
        expect(d.title).toBe(ko.errors.INTERNAL);
        expect(d.detail).toBe("SOMETHING_NEW");
        expect(describeError({ code: "SOMETHING_NEW", message: "boom" }, en).detail).toBe("SOMETHING_NEW: boom");
    });

    it("no duplicate detail when the message equals the English title (either language) or the selected title", () => {
        expect(describeError({ code: "SIGNATURE_REJECTED", message: "Signature rejected" }, en).detail).toBeNull();
        expect(describeError({ code: "SIGNATURE_REJECTED", message: "Signature rejected" }, ko).detail).toBeNull();
        expect(describeError({ code: "SIGNATURE_REJECTED", message: ko.errors.SIGNATURE_REJECTED }, ko).detail).toBeNull();
    });

    it("blank message → no detail", () => {
        expect(describeError({ code: "NOT_FOUND", message: "   " }, ko).detail).toBeNull();
    });
});
