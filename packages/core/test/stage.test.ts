import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { lastWords, newStage, stageMessages, STAGE_TOKENS } from "../src/work/stage";

describe("stages of a big task", () => {
  const big = { contextTokens: STAGE_TOKENS, contextLength: 1_000_000, doneNow: 2, doneAtStage: 1, left: 3 };

  it("starts a new stage only after a checklist step, with a grown context and work left", () => {
    expect(newStage(big)).toBe(true);
    expect(newStage({ ...big, doneNow: 1 })).toBe(false);
    expect(newStage({ ...big, contextTokens: STAGE_TOKENS - 1 })).toBe(false);
    expect(newStage({ ...big, left: 0 })).toBe(false);
  });

  it("starts sooner for a model with a small context", () => {
    expect(newStage({ ...big, contextTokens: 40_000, contextLength: 128_000 })).toBe(true);
  });

  it("keeps what the user wrote and a brief of the work, not what the agent read", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Make a shop" },
      { role: "assistant", content: [{ type: "text", text: "Reading the files." }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "read_file", output: { type: "text", value: "x".repeat(10_000) } }] },
      { role: "assistant", content: [{ type: "text", text: "The catalog is done." }] },
    ];
    const next = stageMessages(messages, [{ text: "Catalog", done: true }, { text: "Cart", done: false }], lastWords(messages));
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ role: "user", content: "Make a shop" });
    expect(next[1]!.content).toContain("- [x] Catalog");
    expect(next[1]!.content).toContain("- [ ] Cart");
    expect(next[1]!.content).toContain("The catalog is done.");
    expect(JSON.stringify(next)).not.toContain("xxxx");
  });
});
