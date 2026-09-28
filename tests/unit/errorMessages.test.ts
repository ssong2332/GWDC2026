import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES, describeError } from "@/ui/errorMessages";

// src/ui/errorMessages.ts (Architecture 에러 처리): code → English text, for API and wallet errors alike.

const API_CODES = [
    "VALIDATION_FAILED",
    "SCHEMA_INVALID",
    "NO_TOOL_CALL",
    "INVALID_ARGS",
    "UNKNOWN_MERCHANT",
    "EXPIRY_REQUIRED",
    "NOT_OWNER",
    "NOT_FOUND",
    "KILN_RATE_LIMITED",
    "KILN_CREDIT_EXHAUSTED",
    "KILN_UNAVAILABLE",
    "KILN_AUTH",
    "KILN_BAD_REQUEST",
    "CHAIN_RPC_ERROR",
    "INTERNAL",
];
const CLIENT_CODES = ["NETWORK_ERROR", "BAD_RESPONSE", "SIGNATURE_REJECTED", "WRONG_NETWORK", "WALLET_ERROR", "NO_WALLET", "TX_REVERTED"];
const CONTRACT_CODES = [
    "CONTRACT_NOT_OWNER",
    "CONTRACT_PENDING_EXISTS",
    "CONTRACT_PENDING_NOT_FOUND",
    "CONTRACT_VAULT_IS_PAUSED",
    "CONTRACT_POLICY_EXPIRED",
    "CONTRACT_ALREADY_PAUSED",
    "CONTRACT_INVALID_POLICY",
];

describe("ERROR_MESSAGES", () => {
    it.each([...API_CODES, ...CLIENT_CODES, ...CONTRACT_CODES])("has an English message for %s", (code) => {
        const text = ERROR_MESSAGES[code];
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(5);
        expect(text).not.toMatch(/[ㄱ-힝]/); // UI language is English (PRD N-11)
    });

    it("signature rejection reads exactly as the design says", () => {
        expect(ERROR_MESSAGES.SIGNATURE_REJECTED).toBe("Signature rejected");
    });
});

describe("describeError", () => {
    it("known code → table text as title, server message as detail", () => {
        expect(describeError({ code: "KILN_CREDIT_EXHAUSTED", message: "Kiln request failed (HTTP 402)" })).toEqual({
            title: ERROR_MESSAGES.KILN_CREDIT_EXHAUSTED,
            detail: "Kiln request failed (HTTP 402)",
        });
    });

    it("unknown code → generic title and the code in the detail", () => {
        const d = describeError({ code: "SOMETHING_NEW", message: "" });
        expect(d.title).toBe(ERROR_MESSAGES.INTERNAL);
        expect(d.detail).toContain("SOMETHING_NEW");
    });

    it("no duplicate detail when the message equals the title", () => {
        expect(describeError({ code: "SIGNATURE_REJECTED", message: "Signature rejected" }).detail).toBeNull();
    });
});
