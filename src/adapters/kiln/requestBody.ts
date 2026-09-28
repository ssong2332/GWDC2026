import { KILN } from "@/config/constants";
import type { ChatBody, ChatTool, JudgeInput, KilnBodyConfig, ParseInput } from "./types";
import { judgeSystemPrompt, judgeUserPrompt, parseSystemPrompt } from "./prompts";
import { intentTool, policyTool } from "./toolSchemas";

export type { ChatBody, ChatTool, JudgeInput, KilnBodyConfig, ParseInput, ThinkingMode } from "./types";

export function buildChatBody(kind: "policy_parse", input: ParseInput, cfg: KilnBodyConfig): ChatBody;
export function buildChatBody(kind: "intent_judge", input: JudgeInput, cfg: KilnBodyConfig): ChatBody;
export function buildChatBody(kind: string, input: unknown, cfg: KilnBodyConfig): ChatBody {
    const isParse = kind === "policy_parse";
    const maxTokens = isParse ? cfg.maxTokensParse : cfg.maxTokensJudge;
    if (!Number.isInteger(maxTokens) || maxTokens < KILN.minMaxTokens)
        throw new RangeError(`max_tokens must be an integer >= ${KILN.minMaxTokens} (reasoning tokens count against it)`);

    let system: string;
    let user: string;
    let tool: ChatTool;
    if (isParse) {
        const p = input as ParseInput;
        system = parseSystemPrompt(p.todayKst, p.merchants);
        user = p.delegationText;
        tool = policyTool(p.merchants);
    } else if (kind === "intent_judge") {
        const j = input as JudgeInput;
        system = judgeSystemPrompt();
        user = judgeUserPrompt(j);
        tool = intentTool();
    } else {
        throw new RangeError(`unknown Kiln flow: ${kind}`);
    }
    if (cfg.thinkingMode === "no_think") system = `${system}
/no_think`;

    // Never add response_format, stop, parallel_tool_calls or a named tool_choice (PRD N-04).
    const body: ChatBody = {
        model: cfg.model,
        messages: [
            { role: "system", content: system },
            { role: "user", content: user },
        ],
        tools: [tool],
        tool_choice: "auto",
        max_tokens: maxTokens,
        temperature: KILN.temperature,
        stream: false,
    };
    if (cfg.thinkingMode === "kwargs_off") body.chat_template_kwargs = { enable_thinking: false };
    return body;
}
