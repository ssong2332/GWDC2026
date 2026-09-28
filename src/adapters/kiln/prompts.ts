import type { MerchantEntry } from "@/core/domain/types";
import type { JudgeInput } from "./types";

// Prompt text for the two Kiln flows. The judge prompt deliberately carries no money limits (D-26):
// code and PolicyVault enforce those, Kiln only judges fit with the delegated purpose.

export function parseSystemPrompt(todayKst: string, merchants: MerchantEntry[]): string {
    const registry = merchants.map((m) => `- ${m.id}: ${[m.displayName, ...m.aliases].join(", ")}`).join("\n");
    return [
        "You convert a Korean club treasurer's delegation sentence into a spending policy.",
        "Call the function submit_spending_policy exactly once with the extracted values. Do not answer in plain text.",
        "Amounts are integer Korean won: '만 원' means x10000, '천 원' means x1000.",
        `Today's date in Asia/Seoul is ${todayKst}.`,
        "Merchant registry (id: names):",
        registry,
        "Use only registry ids in allowed_merchant_ids; list any other merchant names in unrecognized_merchants.",
    ].join("\n");
}

export function judgeSystemPrompt(): string {
    return [
        "You check whether one purchase made by a spending agent fits the purpose its owner delegated.",
        "Judge only whether the item plausibly serves that purpose. Amount rules and merchant rules are enforced elsewhere.",
        "Call the function submit_intent_judgment exactly once. Do not answer in plain text.",
    ].join("\n");
}

export function judgeUserPrompt(i: JudgeInput): string {
    return [
        `Delegated purpose: ${i.purpose}`,
        `Owner's original sentence: ${i.delegationText}`,
        `Merchant: ${i.merchantName}`,
        `Amount (KRW): ${i.amount.toString()}`,
        `Item: ${i.itemDescription}`,
    ].join("\n");
}
