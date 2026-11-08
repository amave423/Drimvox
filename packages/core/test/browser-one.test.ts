import { tool, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { oneBrowser } from "../src/browser/one";

const calls: unknown[] = [];
const fake: ToolSet = {
  browser_open: tool({
    description: "Open an address in the browser and read the page. new_tab keeps the current page.",
    inputSchema: z.object({ url: z.string().url(), new_tab: z.boolean().optional() }),
    execute: async (input) => (calls.push(["open", input]), "opened"),
  }),
  browser_read: tool({ description: "Read the page.", inputSchema: z.object({}), execute: async () => "page" }),
  browser_audit: tool({ description: "Check accessibility.", inputSchema: z.object({}), execute: async () => "audit" }),
  read_file: tool({ description: "Read a file.", inputSchema: z.object({ path: z.string() }), execute: async () => "file" }),
};

// Asked for: fewer tools sent with every step; the browser's own were 15 of them, each with its description.
describe("one browser tool", () => {
  it("puts the browser's usual tools in one, keeps the rare ones and the others as they are", () => {
    const tools = oneBrowser(fake, ["browser_audit"]);
    expect(Object.keys(tools).sort()).toEqual(["browser", "browser_audit", "read_file"]);
    const description = String(tools.browser!.description);
    expect(description).toContain("open {url, new_tab?}: Open an address in the browser and read the page.");
    expect(description).toContain("read {}: Read the page.");
  });

  it("runs the action with its arguments checked as the separate tool checked them", async () => {
    const run = oneBrowser(fake, []).browser!.execute! as (input: Record<string, unknown>, o: object) => Promise<unknown>;
    const opts = { toolCallId: "c1", messages: [] };
    expect(await run({ action: "open", url: "http://localhost:5173/" }, opts)).toBe("opened");
    expect(calls.at(-1)).toEqual(["open", { url: "http://localhost:5173/" }]);
    await expect(run({ action: "open", url: "not an address" }, opts)).rejects.toThrow(/open needs \{url, new_tab\?\}/);
    await expect(run({ action: "fly" }, opts)).rejects.toThrow(/No browser action "fly"/);
  });
});
