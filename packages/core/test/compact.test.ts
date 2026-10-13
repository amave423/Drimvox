import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { compactHistory } from "../src/agent/compact";

/** A conversation where the agent wrote and read a big file `n` times. */
function history(n: number, size = 20_000): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "user", content: "Сделай задачу" }];
  for (let i = 0; i < n; i++) {
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `Шаг ${i}` },
        { type: "tool-call", toolCallId: `c${i}`, toolName: "write_file", input: { path: `f${i}.js`, content: "x".repeat(size) } },
      ],
    });
    messages.push({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "write_file", output: { type: "text", value: `${i}:` + "y".repeat(size) } }],
    });
  }
  return messages;
}
const size = (m: ModelMessage[]) => JSON.stringify(m).length;
const resultText = (m: ModelMessage) => ((m.content as any[])[0].output.value as string);

describe("compactHistory", () => {
  it("leaves a short conversation as it is", () => {
    const short = history(3);
    expect(compactHistory(short)).toBe(short);
  });

  it("cuts old tool outputs and big tool inputs, keeping the latest ones whole", () => {
    const long = history(20);
    const compacted = compactHistory(long);
    expect(size(compacted)).toBeLessThan(size(long) / 2);
    // The newest results stay whole; the oldest keep only their beginning and a note.
    expect(resultText(compacted.at(-1)!)).toBe(resultText(long.at(-1)!));
    expect(resultText(compacted[2]!)).toMatch(/^0:y+/);
    expect(resultText(compacted[2]!)).toMatch(/cut by Artel/);
    expect(((compacted[1]!.content as any[])[1].input.content as string).length).toBeLessThan(500);
    // The task itself and the agent's words are untouched.
    expect(compacted[0]).toEqual(long[0]);
    expect((compacted[1]!.content as any[])[0]).toEqual((long[1]!.content as any[])[0]);
  });

  it("moves its boundary in steps, so the start of the conversation stays the same for the provider's cache", () => {
    const a = compactHistory(history(20));
    const b = compactHistory(history(21));
    expect(JSON.stringify(b.slice(0, a.length))).toBe(JSON.stringify(a));
  });

  // Seen live: DeepSeek's thinking, sent back on every step, was two thirds of what a long task re-read each time.
  it("cuts the model's old reasoning too, keeping the latest whole", () => {
    const long = history(20, 2_000).map((m) =>
      m.role === "assistant" ? { ...m, content: [{ type: "reasoning" as const, text: "r".repeat(30_000) }, ...(m.content as any[])] } : m,
    ) as ModelMessage[];
    const compacted = compactHistory(long);
    const reasoning = (m: ModelMessage) => ((m.content as any[])[0].text as string);
    expect(size(compacted)).toBeLessThan(size(long) / 2);
    expect(reasoning(compacted[1]!)).toMatch(/cut by Artel/);
    expect(reasoning(compacted[1]!).length).toBeLessThan(200);
    expect(reasoning(compacted.at(-2)!)).toBe(reasoning(long.at(-2)!));
  });

  it("changes nothing when given its own result again", () => {
    const once = compactHistory(history(20));
    expect(JSON.stringify(compactHistory(once))).toBe(JSON.stringify(once));
  });
});
