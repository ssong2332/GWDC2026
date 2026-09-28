import { describe, expect, it } from "vitest";
import { interpretIntentOutcome } from "@/core/domain/intent";

const CALL = "call-1";
const toolCall = (args: unknown, functionName = "submit_intent_judgment") => ({
    kind: "tool_call" as const,
    functionName,
    rawArguments: typeof args === "string" ? args : JSON.stringify(args),
});

describe("interpretIntentOutcome — Kiln judge result → IntentJudgment (D-10 fail-closed)", () => {
    it("maps fits_purpose=true to match and keeps Kiln's reason", () => {
        expect(interpretIntentOutcome(toolCall({ fits_purpose: true, reason: "Decorations fit the event." }), CALL)).toEqual({
            status: "match",
            reason: "Decorations fit the event.",
            kilnCallId: CALL,
        });
    });

    it("maps fits_purpose=false to mismatch", () => {
        expect(interpretIntentOutcome(toolCall({ fits_purpose: false, reason: "Personal item." }), CALL)).toMatchObject({
            status: "mismatch",
            reason: "Personal item.",
        });
    });

    it("cuts a reason longer than 200 characters to 200 (boundary: exactly 200 is kept)", () => {
        const exact = "a".repeat(200);
        expect(interpretIntentOutcome(toolCall({ fits_purpose: true, reason: exact }), CALL).reason).toBe(exact);
        const long = "b".repeat(250);
        expect(interpretIntentOutcome(toolCall({ fits_purpose: true, reason: long }), CALL).reason).toBe("b".repeat(200));
    });

    it("treats unparsable, wrongly typed or wrongly named tool calls as invalid_output", () => {
        expect(interpretIntentOutcome(toolCall("{not json"), CALL)).toMatchObject({ status: "invalid_output", reason: "INVALID_ARGS" });
        expect(interpretIntentOutcome(toolCall({ fits_purpose: "yes", reason: "x" }), CALL)).toMatchObject({ status: "invalid_output", reason: "INVALID_ARGS" });
        expect(interpretIntentOutcome(toolCall({ fits_purpose: true, reason: "" }), CALL)).toMatchObject({ status: "invalid_output" });
        expect(interpretIntentOutcome(toolCall({ fits_purpose: true, reason: "x" }, "submit_spending_policy"), CALL)).toMatchObject({
            status: "invalid_output",
            reason: "WRONG_FUNCTION",
        });
    });

    it("treats a missing tool call as invalid_output and an HTTP failure as error with its code", () => {
        expect(interpretIntentOutcome({ kind: "no_tool_call", content: "I think it fits." }, CALL)).toEqual({
            status: "invalid_output",
            reason: "NO_TOOL_CALL",
            kilnCallId: CALL,
        });
        expect(interpretIntentOutcome({ kind: "http_error", status: 402, code: "KILN_CREDIT_EXHAUSTED" }, CALL)).toEqual({
            status: "error",
            reason: "KILN_CREDIT_EXHAUSTED",
            kilnCallId: CALL,
        });
        expect(interpretIntentOutcome({ kind: "http_error", status: 0, code: null }, CALL)).toMatchObject({
            status: "error",
            reason: "KILN_ERROR",
        });
    });
});
