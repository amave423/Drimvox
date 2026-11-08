import { tool, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { codeTool } from "../src/agent/code-mode";

// Asked for: many actions in one step, as OpenCode's Code Mode — a piece of JavaScript calling the other tools.
describe("the execute tool", () => {
  const calls: string[] = [];
  const tools: ToolSet = {
    read_file: tool({
      description: "read",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        calls.push(path);
        return `text of ${path}`;
      },
    }),
    finish: tool({ description: "end", inputSchema: z.object({}), execute: async () => "ended" }),
  };
  const run = (code: string) => codeTool(() => tools, ["finish"]).execute!({ code }, { toolCallId: "x", messages: [] } as never) as Promise<string>;

  it("calls the tools in order, in a loop, and gives back what the code logs and returns", async () => {
    const out = await run(`
      const seen = [];
      for (const p of ["a.txt", "b.txt"]) seen.push(await tools.read_file({ path: p }));
      console.log(seen.length, "read");
      return seen;
    `);
    expect(calls).toEqual(["a.txt", "b.txt"]);
    expect(out).toContain("2 read");
    expect(out).toContain("text of b.txt");
  });

  it("keeps the stop tools and unknown names out, and says what went wrong", async () => {
    expect(await run(`return await tools.finish({})`)).toContain('No tool "finish"');
    expect(await run(`throw new Error("boom")`)).toContain("boom");
  });

  it("gives the code no process and no require: Drimvox's memory and files are out of its reach", async () => {
    expect(await run(`return [typeof process, typeof require]`)).toContain('["undefined","undefined"]');
  });
});
