import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { sizeOf } from "../src/agent/memory";
import { fitContext } from "../src/work/context";

/** A conversation of `n` read_file calls, each with an output of `size` characters. */
function conversation(n: number, size: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "user", content: "Сделай сайт" }];
  for (let i = 0; i < n; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "read_file", input: { path: `f${i}.js` } }] });
    messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "read_file", output: { type: "text", value: "x".repeat(size) } }] });
  }
  return messages;
}

const summary = (upTo: number) => Promise.resolve({ memory: { upTo, summary: "[сводка]" }, inputTokens: 0, outputTokens: 0, costUsd: 0.002 });

// Asked for: "the best of both". The conversation goes whole until it nears the limit; then old outputs are cut, and a
// summary is written only when that is not enough.
describe("fitting a project's conversation to the model", () => {
  it("leaves a conversation below the limit whole", async () => {
    const messages = conversation(20, 10_000);
    const before = structuredClone(messages);
    const write = vi.fn(summary);
    expect(await fitContext(messages, 1_000_000, write)).toEqual({ pruned: false, summarized: false, costUsd: 0 });
    expect(messages).toEqual(before);
    expect(write).not.toHaveBeenCalled();
  });

  it("cuts old outputs past the limit, without a summary when that is enough", async () => {
    const messages = conversation(60, 10_000);
    const write = vi.fn(summary);
    const fitted = await fitContext(messages, 500_000, write);
    expect(fitted.pruned).toBe(true);
    expect(fitted.summarized).toBe(false);
    expect(sizeOf(messages)).toBeLessThan(500_000 * 0.7);
    expect(write).not.toHaveBeenCalled();
  });

  it("writes a summary when cutting outputs is not enough, keeping the task first and the newest part whole", async () => {
    // Long thinking in the agent's own messages: no outputs to cut make room.
    const messages: ModelMessage[] = [{ role: "user", content: "Сделай сайт" }];
    for (let i = 0; i < 40; i++) {
      messages.push({ role: "assistant", content: `Шаг ${i}: ${"рассуждение ".repeat(2_000)}` });
      messages.push({ role: "user", content: "Продолжай." });
    }
    const last = messages.at(-2);
    const write = vi.fn(summary);
    const fitted = await fitContext(messages, 600_000, write);
    expect(fitted).toMatchObject({ summarized: true, costUsd: 0.002 });
    expect(messages[0]).toEqual({ role: "user", content: "Сделай сайт" });
    expect(messages[1]).toEqual({ role: "user", content: "[сводка]" });
    expect(messages.at(-2)).toEqual(last);
    expect(sizeOf(messages)).toBeLessThan(600_000 * 0.5);
  });

  it("shortens when the provider said the request was too long, even below the limit", async () => {
    const messages = conversation(60, 10_000);
    const write = vi.fn(summary);
    const fitted = await fitContext(messages, 100_000_000, write, { force: true });
    expect(fitted.pruned).toBe(true);
    expect(write).toHaveBeenCalled();
  });
});
