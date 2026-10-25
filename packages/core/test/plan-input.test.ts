import type { ProjectPlan } from "@drimvox/shared";
import { describe, expect, it } from "vitest";
import { planTools } from "../src/work/plan";

// Seen live (a star map, Claude Opus 5.5): one step of the plan was 230 characters long, the whole plan was refused
// twice, and the project failed with "the model never wrote the plan". What is too long is trimmed, not refused.
describe("the plan's input", () => {
  it("keeps a plan whose step is too long, trimmed", async () => {
    let saved: ProjectPlan | null = null;
    const write = planTools((p) => (saved = p)).write_plan!;
    const long = `Сделать ${"очень ".repeat(60)}подробную карточку звезды`;
    const input = (write.inputSchema as { parse(v: unknown): unknown }).parse({
      summary: "Карта звёздного неба.",
      steps: ["Каталог звёзд", long, ...Array.from({ length: 40 }, (_, i) => `Шаг ${i}`)],
      decisions: [{ what: "Canvas 2D ".repeat(40), why: "Быстро" }],
    });
    await write.execute!(input as never, { toolCallId: "1", messages: [] } as never);
    expect(saved!.steps!.length).toBe(30);
    expect(saved!.steps![1]!.length).toBeLessThanOrEqual(200);
    expect(saved!.steps![1]!.endsWith("…")).toBe(true);
    expect(saved!.decisions![0]!.what.length).toBeLessThanOrEqual(200);
  });
});
