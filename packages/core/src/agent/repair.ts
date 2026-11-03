import type { ModelMessage, ToolCallRepairFunction, ToolSet } from "ai";

/**
 * JSON with its brackets put right: a closing bracket that closes nothing is dropped, and what is left open at the end
 * is closed. Null when that does not make it valid. (Seen live: DeepSeek wrote five thousand characters of questions
 * for ask_questions with one `}` too many; the call failed and the interview was skipped.)
 */
export function balanceJson(text: string): string | null {
  const open: string[] = [];
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") open.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      if (open.at(-1) !== ch) continue;
      open.pop();
    }
    out += ch;
  }
  if (inString) out += '"';
  out += open.reverse().join("");
  try {
    JSON.parse(out);
    return out;
  } catch {
    return null;
  }
}

/** A tool call whose input is not valid JSON gets its brackets put right before it fails. */
export const repairToolJson: ToolCallRepairFunction<ToolSet> = async ({ toolCall, error }) => {
  if (!/JSON/i.test(error.message)) return null;
  const fixed = balanceJson(toolCall.input);
  return fixed && fixed !== toolCall.input ? { ...toolCall, input: fixed } : null;
};

/**
 * The conversation without tool calls that have no result: a step cut by the output limit in the middle of its calls
 * leaves them unanswered, and the provider refuses every request after (seen live: "Tool results are missing for tool
 * calls …", and the project could do nothing more). An assistant message left with nothing goes too.
 */
export function answeredOnly(messages: ModelMessage[]): ModelMessage[] {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const part of m.content) if (part.type === "tool-result") answered.add(part.toolCallId);
  }
  let changed = false;
  const kept: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content) || !m.content.some((p) => p.type === "tool-call" && !answered.has(p.toolCallId))) {
      kept.push(m);
      continue;
    }
    changed = true;
    const content = m.content.filter((p) => p.type !== "tool-call" || answered.has(p.toolCallId));
    if (content.length) kept.push({ ...m, content });
  }
  return changed ? kept : messages;
}
