import { z } from "zod";
import { INPUT_LIMITS, KILN_FUNCTION_NAMES } from "@/config/constants";
import type { IntentJudgment, KilnOutcome } from "./types";

const intentArgsSchema = z.object({
    fits_purpose: z.boolean(),
    reason: z.string().trim().min(1),
});

/**
 * Turns one Kiln intent-judge outcome into a judgment. Anything that is not a clean
 * `submit_intent_judgment` call is fail-closed (D-10): invalid_output or error, never match.
 */
export function interpretIntentOutcome(outcome: KilnOutcome, kilnCallId: string): IntentJudgment {
    const judgment = (status: IntentJudgment["status"], reason: string): IntentJudgment => ({ status, reason, kilnCallId });

    if (outcome.kind === "http_error") return judgment("error", outcome.code ?? "KILN_ERROR");
    if (outcome.kind === "no_tool_call") return judgment("invalid_output", "NO_TOOL_CALL");
    if (outcome.functionName !== KILN_FUNCTION_NAMES.intent) return judgment("invalid_output", "WRONG_FUNCTION");

    let parsed: unknown;
    try {
        parsed = JSON.parse(outcome.rawArguments);
    } catch {
        return judgment("invalid_output", "INVALID_ARGS");
    }
    const r = intentArgsSchema.safeParse(parsed);
    if (!r.success) return judgment("invalid_output", "INVALID_ARGS");
    return judgment(r.data.fits_purpose ? "match" : "mismatch", r.data.reason.slice(0, INPUT_LIMITS.intentReasonMax));
}
