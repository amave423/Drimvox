import { describe, expect, it } from "vitest";
import { smartness } from "../src/providers/smart";

// Asked for: "Auto: for code" puts the smarter models first, not the fastest.
describe("smartness", () => {
  const order = (ids: string[]) => [...ids].sort((a, b) => smartness(b) - smartness(a));

  it("puts the strong open families before small and fast models", () => {
    expect(order(["meta-llama/llama-3.2-3b-instruct:free", "deepseek/deepseek-v4:free", "google/gemma-3-12b-it:free", "qwen/qwen3-coder:free"])).toEqual([
      "qwen/qwen3-coder:free",
      "deepseek/deepseek-v4:free",
      "google/gemma-3-12b-it:free",
      "meta-llama/llama-3.2-3b-instruct:free",
    ]);
  });

  it("puts a bigger model of a family before a smaller one, and the flash variant after the full one", () => {
    expect(smartness("gpt-oss-120b")).toBeGreaterThan(smartness("gpt-oss-20b"));
    expect(smartness("glm-4.6")).toBeGreaterThan(smartness("glm-4.5-air"));
    expect(smartness("gemini-3-pro")).toBeGreaterThan(smartness("gemini-3-flash"));
    expect(smartness("deepseek-v4-pro")).toBeGreaterThan(smartness("mistral-small-3.2-24b"));
  });
});
