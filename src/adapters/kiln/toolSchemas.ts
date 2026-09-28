import { KILN_FUNCTION_NAMES } from "@/config/constants";
import type { MerchantEntry } from "@/core/domain/types";
import type { ChatTool } from "./types";

// Function definitions from Architecture 4. qwen3-32b on Kiln rejects functions without a description (400).

export function policyTool(merchants: MerchantEntry[]): ChatTool {
    return {
        type: "function",
        function: {
            name: KILN_FUNCTION_NAMES.policy,
            description:
                "Submit the spending policy extracted from the owner's delegation sentence. Call exactly once. All amounts are integer Korean won (e.g. '20만 원' = 200000).",
            parameters: {
                type: "object",
                properties: {
                    total_budget_krw: { type: "integer", description: "Total delegated budget in KRW." },
                    approval_threshold_krw: {
                        type: "integer",
                        description:
                            "Per-purchase amount in KRW above which the owner must approve. If not stated, use the total budget.",
                    },
                    allowed_merchant_ids: {
                        type: "array",
                        items: { type: "string", enum: merchants.map((m) => m.id) },
                        description: "Registry ids of the merchants the owner allowed.",
                    },
                    unrecognized_merchants: {
                        type: "array",
                        items: { type: "string" },
                        description: "Merchant names mentioned by the owner that are not in the registry.",
                    },
                    expires_on: {
                        type: ["string", "null"],
                        description:
                            "Deadline as YYYY-MM-DD if the sentence states one (resolve relative dates from today's date in the system message), otherwise null.",
                    },
                    purpose: {
                        type: "string",
                        description: "Short English summary of what the money is for, max 200 characters.",
                    },
                },
                required: ["total_budget_krw", "approval_threshold_krw", "allowed_merchant_ids", "expires_on", "purpose"],
            },
        },
    };
}

export function intentTool(): ChatTool {
    return {
        type: "function",
        function: {
            name: KILN_FUNCTION_NAMES.intent,
            description:
                "Report whether one purchase request fits the purpose the owner delegated. Do not judge budget, limits or merchants; code enforces those. Call exactly once.",
            parameters: {
                type: "object",
                properties: {
                    fits_purpose: {
                        type: "boolean",
                        description: "true if the purchase plausibly serves the delegated purpose.",
                    },
                    reason: { type: "string", description: "One sentence, max 200 characters." },
                },
                required: ["fits_purpose", "reason"],
            },
        },
    };
}
