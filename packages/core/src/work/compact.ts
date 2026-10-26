import type { ModelMessage } from "ai";

/** The newest messages kept whole: the agent's last steps, which it still reasons about. */
export const KEEP_WHOLE = 40;
/** What is left of an older tool's output or a long argument. */
const OUTPUT_KEPT = 600;
const INPUT_KEPT = 400;
const NOTE = "… (trimmed by Drimvox to keep the conversation short; read the file or run the command again if you need it)";

const cut = (text: string, keep: number) => (text.length > keep + NOTE.length ? `${text.slice(0, keep)}${NOTE}` : text);

/**
 * Shortens the older part of a long run's conversation in place (seen live: a star map took 347 steps and sent the model
 * 64 million tokens, on average 185 thousand per step, mostly old command outputs and whole files written long ago).
 * Tool outputs and long arguments (a written file's text) older than the last `keepWhole` messages are trimmed; the
 * words of the user and of the agent, and what each step did, stay. Returns how many characters were cut.
 */
export function compactHistory(messages: ModelMessage[], keepWhole = KEEP_WHOLE): number {
  let saved = 0;
  const end = Math.max(0, messages.length - keepWhole);
  for (let i = 0; i < end; i++) {
    const m = messages[i]!;
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as unknown as Record<string, unknown>[]) {
      if (part.type === "tool-result") {
        const output = part.output as { type?: string; value?: unknown } | undefined;
        if (output && (output.type === "text" || output.type === "error-text") && typeof output.value === "string") {
          const short = cut(output.value, OUTPUT_KEPT);
          saved += output.value.length - short.length;
          output.value = short;
        } else if (output && (output.type === "json" || output.type === "error-json")) {
          const text = JSON.stringify(output.value);
          if (text.length > OUTPUT_KEPT + NOTE.length) {
            saved += text.length - OUTPUT_KEPT;
            part.output = { type: "text", value: cut(text, OUTPUT_KEPT) };
          }
        }
      }
      if (part.type === "tool-call" && part.input && typeof part.input === "object") {
        const input = part.input as Record<string, unknown>;
        for (const [key, value] of Object.entries(input)) {
          if (typeof value !== "string") continue;
          const short = cut(value, INPUT_KEPT);
          saved += value.length - short.length;
          input[key] = short;
        }
      }
    }
  }
  return saved;
}
