import type { ChecklistItem } from "@drimvox/shared";
import type { ModelMessage } from "ai";

/** A stage ends when the context is this big and a step of the checklist got done: the next one starts fresh. */
export const STAGE_TOKENS = 60_000;
/** At most this share of what the model holds, for models with a small context. */
const STAGE_SHARE = 0.3;

/**
 * Whether a big planned task starts its next stage with a fresh context (asked for: as stages, so every step does not
 * send the whole history again): only between answers, only after a checklist step got done since the last stage, so
 * the agent never loses the middle of a piece of work, and only when the context has grown.
 */
export function newStage(o: { contextTokens: number; contextLength: number | null; doneNow: number; doneAtStage: number; left: number }): boolean {
  const limit = Math.min(STAGE_TOKENS, o.contextLength ? Math.floor(o.contextLength * STAGE_SHARE) : STAGE_TOKENS);
  return o.left > 0 && o.doneNow > o.doneAtStage && o.contextTokens >= limit;
}

/**
 * The conversation a new stage starts with: what the user wrote, and a brief of where the work is. What the agent read
 * and ran before is gone; the files, the checklist and the notes hold what matters.
 */
export function stageMessages(messages: ModelMessage[], checklist: ChecklistItem[], lastWords: string): ModelMessage[] {
  const asked = messages.filter((m) => m.role === "user");
  const items = checklist.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n");
  const brief = [
    "A new stage of the work starts here with a fresh context: what you read and ran before is not in this conversation " +
      "any more. The work so far is in the project's files and in the checklist.",
    `Checklist:\n${items}`,
    lastWords.trim() ? `What you said last:\n${lastWords.trim().slice(0, 2_000)}` : "",
    "Go on with the first unchecked step. Read the files it touches again before you change them (the project's notes in " +
      "AGENTS.md say what the next agent must know).",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [...asked, { role: "user", content: brief }];
}

/** The text of the agent's last answer that had any. */
export function lastWords(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    if (text.trim()) return text;
  }
  return "";
}
