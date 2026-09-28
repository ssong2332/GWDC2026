/** Removes Qwen3 <think>…</think> blocks (and an unclosed trailing one cut off by max_tokens). */
export function stripThink(content: string): string {
    return content
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/<think>[\s\S]*$/, "")
        .trim();
}
