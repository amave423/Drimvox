import { tool, type ModelMessage } from "ai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { traceStep } from "../src/agent/trace";

// Asked for: to know where 63 thousand tokens a step go.
describe("the step trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "drimvox-trace-"));
  afterEach(() => {
    delete process.env.DRIMVOX_TRACE_STEPS;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the sizes of a request's parts, not its content, only when asked", () => {
    const tools = { read_file: tool({ description: "Read a file.", inputSchema: z.object({ path: z.string() }), execute: async () => "" }) };
    const messages: ModelMessage[] = [
      { role: "user", content: "Сделай сайт" },
      { role: "assistant", content: [{ type: "reasoning", text: "секретная мысль" }, { type: "tool-call", toolCallId: "c", toolName: "read_file", input: { path: "a" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "read_file", output: { type: "text", value: "x".repeat(500) } }] },
    ];
    traceStep("system", tools, undefined, messages);
    const file = join(dir, "trace.jsonl");
    process.env.DRIMVOX_TRACE_STEPS = file;
    traceStep("system", tools, undefined, messages);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!);
    expect(row).toMatchObject({ system: 6, toolCount: 1, messages: 3, user: 11 });
    expect(row.tools).toBeGreaterThan(20);
    expect(row.reasoning).toBeGreaterThan(15);
    expect(row.toolResult).toBeGreaterThan(500);
    expect(lines[0]).not.toContain("секретная");
  });
});
