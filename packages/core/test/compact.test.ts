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

  // Seen live: after 362 steps each step still sent half a million characters, mostly beginnings left of cut items.
  it("folds what is far back into a line each, keeping the cache-friendly steps", () => {
    const long = history(150, 3_000);
    const compacted = compactHistory(long);
    // Each step far back adds a couple of lines, not the beginnings of everything it did.
    const perStep = (size(compacted) - size(compactHistory(history(105, 3_000)))) / 45;
    expect(perStep).toBeLessThan(500);
    // Far back: a line; near: the usual beginning; the newest: whole.
    expect(resultText(compacted[2]!).length).toBeLessThan(200);
    expect(resultText(compacted[2]!)).toMatch(/cut by Artel/);
    expect(resultText(compacted.at(-1)!)).toBe(resultText(long.at(-1)!));
    // Another step leaves the folded start as it was.
    const next = compactHistory(history(151, 3_000));
    expect(JSON.stringify(next.slice(0, 200))).toBe(JSON.stringify(compacted.slice(0, 200)));
    expect(JSON.stringify(compactHistory(compacted))).toBe(JSON.stringify(compacted));
  });

  // Seen live: with its old commands folded to notes, an agent sent such a note as its next command.
  it("keeps the agent's commands as they were, folding only very long ones", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Сделай задачу" }];
    for (let i = 0; i < 150; i++) {
      const command = i === 0 ? `node -e "${"x".repeat(3_000)}"` : `npm run typecheck 2>&1 | Select-String -Pattern "error TS" | Select-Object -First 25; npm run test -- tests/part-${i}.test.ts tests/sky tests/time 2>&1 | Select-String -Pattern "Test Files|Tests |×"`;
      messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "run_command", input: { command } }] });
      messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "run_command", output: { type: "text", value: "y".repeat(3_000) } }] });
    }
    const compacted = compactHistory(messages);
    const command = (m: ModelMessage) => ((m.content as any[])[0].input.command as string);
    expect(command(compacted[3]!)).toBe(command(messages[3]!));
    expect(command(compacted[1]!)).toMatch(/cut by Artel/);
  });

  it("changes nothing when given its own result again", () => {
    const once = compactHistory(history(20));
    expect(JSON.stringify(compactHistory(once))).toBe(JSON.stringify(once));
  });
});
