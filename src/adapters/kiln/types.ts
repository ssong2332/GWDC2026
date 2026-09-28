import type { MerchantEntry } from "@/core/domain/types";

export type ThinkingMode = "default" | "kwargs_off" | "no_think";
export type KilnBodyConfig = { model: string; maxTokensParse: number; maxTokensJudge: number; thinkingMode: ThinkingMode };
export type ParseInput = { delegationText: string; todayKst: string; merchants: MerchantEntry[] };
export type JudgeInput = { purpose: string; delegationText: string; merchantName: string; amount: bigint; itemDescription: string };
export type ChatTool = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ChatBody = {
    model: string;
    messages: { role: "system" | "user"; content: string }[];
    tools: ChatTool[];
    tool_choice: "auto";
    max_tokens: number;
    temperature: number;
    stream: false;
    chat_template_kwargs?: { enable_thinking: boolean };
};
