import type { ModelMessage } from "ai";

/**
 * Every step sends the whole conversation again, and old file reads, command outputs and the model's own thinking make
 * most of it. Once the conversation is big, the older ones are cut to their beginning (thinking to a note). The cut moves in steps of CHUNK results, so the start
 * of the conversation stays the same for many steps in a row and providers keep serving it from their cache.
 */
const THRESHOLD_CHARS = 120_000;
/** The newest tool results the agent always sees whole. */
const KEEP = 6;
const CHUNK = 6;
/** What is left of a cut output or input. */
const HEAD = 300;
export const MARK = "cut by Artel";

/** The conversation as the model gets it for the next step; the same array when nothing needs cutting. */
export function compactHistory(messages: ModelMessage[]): ModelMessage[] {
  if (JSON.stringify(messages).length < THRESHOLD_CHARS) return messages;
  const results: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") for (const part of m.content) if (part.type === "tool-result") results.push(i);
  });
  const cutBefore = Math.floor(Math.max(0, results.length - KEEP) / CHUNK) * CHUNK;
  if (cutBefore === 0) return messages;
  const boundary = results[cutBefore]!;
  return messages.map((m, i) => (i < boundary ? cutMessage(m) : m));
}

function cutMessage(m: ModelMessage): ModelMessage {
  if (m.role === "tool") {
    return {
      ...m,
      content: m.content.map((part) => {
        if (part.type !== "tool-result") return part;
        const output = part.output;
        const text = output.type === "text" || output.type === "error-text" ? output.value : output.type === "json" || output.type === "error-json" ? JSON.stringify(output.value) : null;
        if (text === null || text.length <= HEAD * 2 || text.includes(MARK)) return part;
        return { ...part, output: { type: "text" as const, value: cut(text, `${part.toolName} output`) } };
      }),
    };
  }
  if (m.role === "assistant" && Array.isArray(m.content)) {
    return {
      ...m,
      content: m.content.map((part) => {
        // Old thinking is spent: the part stays (DeepSeek wants it back) but only as a note.
        if (part.type === "reasoning") return part.text.length <= HEAD || part.text.includes(MARK) ? part : { ...part, text: `[earlier reasoning ${MARK}]` };
        if (part.type !== "tool-call" || !part.input || typeof part.input !== "object") return part;
        const input = part.input as Record<string, unknown>;
        const long = Object.entries(input).filter(([, v]) => typeof v === "string" && v.length > HEAD * 2 && !v.includes(MARK));
        if (long.length === 0) return part;
        // What the agent wrote goes whole, with no beginning left: seen live, an agent copied a cut write back into
        // the file as if it were the file. The file itself is on disk.
        const where = typeof input.path === "string" ? ` to ${input.path}` : "";
        const note = (k: string, v: string) => `[${v.length} characters of ${k} written${where} were ${MARK} from this history; read the file for its current text]`;
        return { ...part, input: { ...input, ...Object.fromEntries(long.map(([k, v]) => [k, note(k, v as string)])) } };
      }),
    };
  }
  return m;
}

function cut(text: string, what: string): string {
  return `${text.slice(0, HEAD)}\n[… ${text.length - HEAD} more characters of this ${what} ${MARK} to save space; read or run it again if you need them]`;
}
