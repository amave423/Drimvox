import { asSchema, type ModelMessage, type ToolSet } from "ai";
import { appendFileSync } from "node:fs";

/**
 * What every request of the agent is made of, in characters, written to the file DRIMVOX_TRACE_STEPS names (asked for: to
 * know where 63 thousand tokens a step go). Off unless the variable is set; nothing of the content is written, sizes only.
 */
export function traceStep(system: string, tools: ToolSet, active: string[] | undefined, messages: ModelMessage[]): void {
  const file = process.env.DRIMVOX_TRACE_STEPS;
  if (!file) return;
  const parts: Record<string, number> = { user: 0, text: 0, reasoning: 0, toolCall: 0, toolResult: 0 };
  for (const m of messages) {
    if (typeof m.content === "string") {
      parts[m.role === "user" ? "user" : "text"]! += m.content.length;
      continue;
    }
    for (const p of m.content as unknown as Record<string, unknown>[]) {
      const size = JSON.stringify(p).length;
      if (m.role === "user") parts.user! += size;
      else if (p.type === "reasoning") parts.reasoning! += size;
      else if (p.type === "tool-call") parts.toolCall! += size;
      else if (p.type === "tool-result") parts.toolResult! += size;
      else parts.text! += size;
    }
  }
  const names = active ?? Object.keys(tools);
  const toolChars = names.reduce((sum, n) => {
    const t = tools[n];
    if (!t) return sum;
    let schema = "";
    try {
      schema = JSON.stringify(asSchema(t.inputSchema as Parameters<typeof asSchema>[0]).jsonSchema);
    } catch {
      // A schema that cannot be written out counts as none.
    }
    return sum + n.length + String(t.description ?? "").length + schema.length;
  }, 0);
  try {
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), system: system.length, tools: toolChars, toolCount: names.length, messages: messages.length, ...parts })}\n`);
  } catch {
    // A trace that cannot be written does not stop the work.
  }
}

/**
 * What a step cost, by part, in the same file: input from the cache and not, the answer and its thinking, and the bill
 * (asked for: to know whether the input or the answer makes the cost).
 */
export function traceUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
  reasoningTokens?: number;
}, costUsd: number, raw?: unknown): void {
  const file = process.env.DRIMVOX_TRACE_STEPS;
  if (!file) return;
  const input = usage.inputTokens ?? 0;
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const row = {
    at: Date.now(),
    usage: true,
    input,
    cached,
    uncached: input - cached,
    output: usage.outputTokens ?? 0,
    reasoning: usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens ?? 0,
    costUsd,
    // As the provider sent it: its own names for the cache and the thinking, and its bill in its currency.
    raw: raw ?? null,
  };
  try {
    appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch {
    // A trace that cannot be written does not stop the work.
  }
}
