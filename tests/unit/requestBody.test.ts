import { describe, expect, it } from "vitest";
import { buildChatBody, type KilnBodyConfig } from "@/adapters/kiln/requestBody";
import { MERCHANT_REGISTRY } from "@/config/merchants";

const CFG: KilnBodyConfig = { model: "qwen3-32b", maxTokensParse: 2048, maxTokensJudge: 1024, thinkingMode: "default" };
const PARSE_INPUT = {
    delegationText: "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐",
    todayKst: "2026-09-28",
    merchants: MERCHANT_REGISTRY,
};
const JUDGE_INPUT = {
    purpose: "Supplies for the student club welcome party",
    delegationText: PARSE_INPUT.delegationText,
    merchantName: "Daiso",
    amount: 30_000n,
    itemDescription: "Balloons and table decorations",
};

type Body = ReturnType<typeof buildChatBody>;
const both = (): [string, Body][] => [
    ["policy_parse", buildChatBody("policy_parse", PARSE_INPUT, CFG)],
    ["intent_judge", buildChatBody("intent_judge", JUDGE_INPUT, CFG)],
];

describe("buildChatBody — qwen3-32b request rules (F-01 ③, PRD N-04)", () => {
    it("never sends response_format, stop, parallel_tool_calls or a forced tool_choice", () => {
        for (const [kind, body] of both()) {
            expect(body, kind).not.toHaveProperty("response_format");
            expect(body, kind).not.toHaveProperty("stop");
            expect(body, kind).not.toHaveProperty("parallel_tool_calls");
            expect(body.tool_choice, kind).toBe("auto");
            expect(body.stream, kind).toBe(false);
        }
    });

    it("declares exactly one function per call and every function has a non-empty description", () => {
        const [[, parse], [, judge]] = both();
        expect(parse.tools.map((t) => t.function.name)).toEqual(["submit_spending_policy"]);
        expect(judge.tools.map((t) => t.function.name)).toEqual(["submit_intent_judgment"]);
        for (const [, body] of both()) {
            for (const t of body.tools) {
                expect(t.type).toBe("function");
                expect(t.function.description.length).toBeGreaterThan(20);
                const props = (t.function.parameters as { properties: Record<string, { description?: string }> }).properties;
                for (const [name, p] of Object.entries(props)) expect(p.description, name).toBeTruthy();
            }
        }
    });

    it("builds the merchant enum from the registry at runtime and sends system + user messages only", () => {
        const parse = buildChatBody("policy_parse", PARSE_INPUT, CFG);
        const props = (parse.tools[0].function.parameters as { properties: Record<string, { items?: { enum?: string[] } }> })
            .properties;
        expect(props.allowed_merchant_ids.items?.enum).toEqual(["daiso", "coupang", "gmarket"]);
        expect(parse.messages.map((m) => m.role)).toEqual(["system", "user"]);
        expect(parse.messages[0].content).toContain("2026-09-28");
        expect(parse.messages[0].content).toContain("다이소");
        expect(parse.messages[1].content).toBe(PARSE_INPUT.delegationText);
    });

    it("keeps budget, balance and limits out of the intent prompt (D-26) but includes the five judge inputs", () => {
        const judge = buildChatBody("intent_judge", JUDGE_INPUT, CFG);
        const text = judge.messages.map((m) => m.content).join("\n");
        expect(text).toContain(JUDGE_INPUT.purpose);
        expect(text).toContain(JUDGE_INPUT.delegationText);
        expect(text).toContain("Daiso");
        expect(text).toContain("30000");
        expect(text).toContain(JUDGE_INPUT.itemDescription);
        expect(text).not.toMatch(/remaining|balance|threshold|limit/i);
    });

    it("uses model, temperature 0 and per-flow max_tokens from config; 500 is the accepted minimum", () => {
        expect(buildChatBody("policy_parse", PARSE_INPUT, CFG)).toMatchObject({ model: "qwen3-32b", temperature: 0, max_tokens: 2048 });
        expect(buildChatBody("intent_judge", JUDGE_INPUT, CFG).max_tokens).toBe(1024);
        expect(buildChatBody("intent_judge", JUDGE_INPUT, { ...CFG, maxTokensJudge: 500 }).max_tokens).toBe(500);
    });

    it("refuses max_tokens below 500 (reasoning tokens count against it)", () => {
        expect(() => buildChatBody("intent_judge", JUDGE_INPUT, { ...CFG, maxTokensJudge: 499 })).toThrow(/500/);
        expect(() => buildChatBody("policy_parse", PARSE_INPUT, { ...CFG, maxTokensParse: 0 })).toThrow(/500/);
    });

    it("applies the thinking-mode flag: default adds nothing, kwargs_off adds chat_template_kwargs, no_think appends /no_think", () => {
        const def = buildChatBody("intent_judge", JUDGE_INPUT, CFG);
        expect(def).not.toHaveProperty("chat_template_kwargs");
        expect(def.messages[0].content).not.toContain("/no_think");

        const off = buildChatBody("intent_judge", JUDGE_INPUT, { ...CFG, thinkingMode: "kwargs_off" });
        expect(off).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });

        const noThink = buildChatBody("intent_judge", JUDGE_INPUT, { ...CFG, thinkingMode: "no_think" });
        expect(noThink.messages[0].content.endsWith("/no_think")).toBe(true);
        expect(noThink).not.toHaveProperty("chat_template_kwargs");
    });
});
