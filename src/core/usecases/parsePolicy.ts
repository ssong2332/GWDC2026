import { INPUT_LIMITS, KILN_FUNCTION_NAMES } from "@/config/constants";
import { kstDate, validatePolicyArgs } from "@/core/domain/policy";
import type { Hex, MerchantEntry, PolicyCandidate } from "@/core/domain/types";
import { AppError } from "@/core/errors";
import type { Clock, KilnCallRepo, KilnClient } from "@/core/ports";
import { saveKilnCall } from "./kilnRecords";

export type ParsePolicyDeps = {
    kiln: KilnClient;
    kilnCalls: KilnCallRepo;
    merchants: MerchantEntry[];
    clock: Clock;
    chainId: number;
    vault: Hex;
};

export type ParsePolicyResult =
    | { ok: true; parseCallId: string; candidate: PolicyCandidate; warnings: string[] }
    | { ok: false; code: string; message: string; parseCallId: string | null };

/**
 * F-01: delegation sentence → Kiln `submit_spending_policy` → validated candidate. Nothing becomes a policy
 * candidate unless the arguments pass every rule; every Kiln call is recorded with flow `policy_parse`.
 */
export async function parsePolicy(deps: ParsePolicyDeps, i: { delegationText: string }): Promise<ParsePolicyResult> {
    const text = i.delegationText;
    if (text.trim().length === 0 || text.length > INPUT_LIMITS.delegationTextMax)
        throw new AppError("VALIDATION_FAILED", `delegationText must be 1..${INPUT_LIMITS.delegationTextMax} characters`);

    const result = await deps.kiln.parsePolicy({
        delegationText: text,
        todayKst: kstDate(deps.clock.now()),
        merchants: deps.merchants,
    });
    saveKilnCall(deps.kilnCalls, result, { chainId: deps.chainId, vault: deps.vault, requestId: null });
    const parseCallId = result.record.callId;
    const o = result.outcome;

    if (o.kind === "http_error")
        return { ok: false, code: o.code ?? "KILN_UNAVAILABLE", message: `Kiln request failed (HTTP ${o.status})`, parseCallId };
    if (o.kind === "no_tool_call")
        return { ok: false, code: "NO_TOOL_CALL", message: "Kiln did not call the policy function", parseCallId };
    if (o.functionName !== KILN_FUNCTION_NAMES.policy)
        return { ok: false, code: "INVALID_ARGS", message: `Kiln called an unexpected function: ${o.functionName}`, parseCallId };

    const v = validatePolicyArgs(o.rawArguments, deps.merchants);
    if (!v.ok) return { ok: false, code: v.code, message: v.message, parseCallId };
    return { ok: true, parseCallId, candidate: v.candidate, warnings: v.warnings };
}
