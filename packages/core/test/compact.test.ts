import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { compactHistory } from "../src/work/compact";

const step = (n: number, output: string, content = "x"): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${n}`, toolName: "write_file", input: { path: `f${n}.js`, content } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: `c${n}`, toolName: "write_file", output: { type: "text", value: output } }] },
];

// Seen live: 347 steps of a star map sent the model 64 million tokens, mostly old outputs and whole files written long ago.
describe("compacting a long run's conversation", () => {
  it("trims old tool outputs and written files, keeps the newest steps and everyone's words whole", () => {
    const big = "y".repeat(20_000);
    const messages: ModelMessage[] = [
      { role: "user", content: "Сделай карту звёздного неба" },
      ...step(1, big, big),
      { role: "assistant", content: [{ type: "text", text: "Пишу данные." }] },
      ...step(2, big, big),
      ...step(3, big, big),
    ];
    const saved = compactHistory(messages, 2);
    expect(saved).toBeGreaterThan(60_000);
    expect(messages[0]!.content).toBe("Сделай карту звёздного неба");
    const oldCall = (messages[1]!.content as any)[0];
    expect(oldCall.input.path).toBe("f1.js");
    expect(oldCall.input.content.length).toBeLessThan(600);
    const oldResult = (messages[2]!.content as any)[0];
    expect(oldResult.output.value).toMatch(/trimmed by Drimvox/);
    expect((messages[3]!.content as any)[0].text).toBe("Пишу данные.");
    // The last two messages stay as they were.
    expect((messages.at(-2)!.content as any)[0].input.content).toBe(big);
    expect((messages.at(-1)!.content as any)[0].output.value).toBe(big);
    // Done twice, nothing more is cut.
    expect(compactHistory(messages, 2)).toBe(0);
  });

  // Seen live: frontend-design was opened first, and an answer later all that was left of it was its first 600 characters.
  it("keeps a skill's instructions whole: they are followed the whole run", () => {
    const skill = "Правило дизайна. ".repeat(1000);
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "s", toolName: "use_skill", input: { name: "frontend-design" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "s", toolName: "use_skill", output: { type: "text", value: skill } }] },
      ...step(1, "y".repeat(20_000)),
    ];
    compactHistory(messages, 0);
    expect((messages[1]!.content as any)[0].output.value).toBe(skill);
    expect((messages[3]!.content as any)[0].output.value).toMatch(/trimmed by Drimvox/);
  });
});
