import type { ModelMessage } from "ai";

/**
 * Old tool outputs leave the conversation as OpenCode prunes them (asked for: faster and cheaper). Seen live: every step of a
 * weather site sent the model all it had read and written since the start, 61 thousand tokens a step on average, up to
 * 112 thousand at the end, while the model's window held far more and the summary of memory.ts never came. The newest
 * outputs stay whole (about 40 thousand tokens); older ones become a line saying what they were. The line moves in chunks
 * of about 20 thousand tokens: between moves the start of every request is the same and the provider's cache holds.
 */
export const PROTECT = 140_000;
export const CHUNK = 70_000;
/** Outputs shorter than this cost little and say much ("Written.", an error): they stay. */
const MIN_PRUNED = 300;
/** A skill's instructions are followed the whole run (compact.ts). */
const KEPT_WHOLE = new Set(["use_skill", "read_skill_file"]);

type Part = Record<string, unknown>;
interface Item {
  message: number;
  part: number;
  /** A tool-call's argument, or the tool-result's output when absent. */
  key?: string;
  size: number;
}

const textOf = (output: unknown): string | null => {
  const o = output as { type?: string; value?: unknown } | undefined;
  if (!o) return null;
  if ((o.type === "text" || o.type === "error-text") && typeof o.value === "string") return o.value;
  if (o.type === "json" || o.type === "error-json") return JSON.stringify(o.value);
  return null;
};
const linesOf = (text: string) => text.replace(/\n$/, "").split("\n").length;

/** The conversation with its older outputs pruned, on a copy; the messages given stay as they are. */
export function pruneOutputs(messages: ModelMessage[], protect = PROTECT, chunk = CHUNK): { messages: ModelMessage[]; saved: number } {
  const items: Item[] = [];
  // What each call was about, for the line that replaces its result: the file, the command, the address.
  const about = new Map<string, string>();
  messages.forEach((m, mi) => {
    if (!Array.isArray(m.content)) return;
    (m.content as unknown as Part[]).forEach((part, pi) => {
      if (part.type === "tool-call" && part.input && typeof part.input === "object") {
        const input = part.input as Record<string, unknown>;
        const what = [input.path, input.command, input.url, input.action].find((v) => typeof v === "string");
        if (what) about.set(String(part.toolCallId), String(what).slice(0, 120));
        if (KEPT_WHOLE.has(String(part.toolName))) return;
        for (const [key, value] of Object.entries(input)) if (typeof value === "string" && value.length >= MIN_PRUNED) items.push({ message: mi, part: pi, key, size: value.length });
      }
      if (part.type === "tool-result" && !KEPT_WHOLE.has(String(part.toolName))) {
        const text = textOf(part.output);
        if (text && text.length >= MIN_PRUNED) items.push({ message: mi, part: pi, size: text.length });
      }
    });
  });
  const total = items.reduce((sum, it) => sum + it.size, 0);
  const allowed = Math.floor(Math.max(0, total - protect) / chunk) * chunk;
  if (!allowed) return { messages, saved: 0 };

  const chosen: Item[] = [];
  let pruned = 0;
  let after = total;
  for (const it of items) {
    after -= it.size;
    // The newest outputs, about `protect` of them, always stay.
    if (pruned >= allowed || after < protect) break;
    chosen.push(it);
    pruned += it.size;
  }
  if (!chosen.length) return { messages, saved: 0 };

  const sent = messages.map((m, mi) =>
    chosen.some((it) => it.message === mi) ? ({ ...m, content: (m.content as unknown as Part[]).map((p) => ({ ...p })) } as unknown as ModelMessage) : m,
  );
  let saved = 0;
  for (const it of chosen) {
    const part = (sent[it.message]!.content as unknown as Part[])[it.part]!;
    if (it.key) {
      const input = { ...(part.input as Record<string, unknown>) };
      const value = String(input[it.key]);
      input[it.key] = `[${linesOf(value)} lines written; removed from the history to keep it short, the file holds them]`;
      saved += value.length - String(input[it.key]).length;
      part.input = input;
    } else {
      const text = textOf(part.output)!;
      const what = about.get(String(part.toolCallId));
      const line = `[Drimvox: an old result of ${String(part.toolName)}${what ? ` ${what}` : ""}, ${linesOf(text)} lines, removed to keep the conversation short; run the tool again if you need it]`;
      part.output = { type: "text", value: line };
      saved += text.length - line.length;
    }
  }
  return { messages: sent, saved };
}
