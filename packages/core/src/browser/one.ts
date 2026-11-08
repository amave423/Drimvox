import { tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * The browser's usual tools as one, `browser` with an action (asked for: fewer tools sent with every step). Each of the 15
 * went with every request with its own description and schema; one tool lists them in a line each. The arguments are
 * checked by the separate tool's own schema, and the feed shows the separate tool's name, as before.
 */
export function oneBrowser(tools: ToolSet, keepApart: string[]): ToolSet {
  const merged = Object.keys(tools).filter((n) => n.startsWith("browser_") && !keepApart.includes(n));
  if (merged.length < 2) return tools;
  const shape = (name: string) => {
    const schema = tools[name]!.inputSchema as unknown as z.ZodObject;
    const fields = Object.entries(schema.shape ?? {}).map(([key, field]) => (field.safeParse(undefined).success ? `${key}?` : key));
    return `{${fields.join(", ")}}`;
  };
  const first = (name: string) => String(tools[name]!.description ?? "").split(/(?<=\.)\s/)[0];
  const actions = merged.map((n) => n.slice("browser_".length));
  const browser = tool({
    description:
      "A real browser the user sees in Drimvox's Browser panel; the project's own pages open in it too. Give an action and its " +
      "arguments beside it, as {action: \"open\", url: \"http://localhost:5173/\"}. Actions:\n" +
      merged.map((n) => `${n.slice("browser_".length)} ${shape(n)}: ${first(n)}`).join("\n"),
    inputSchema: z.looseObject({ action: z.enum(actions as [string, ...string[]]) }),
    execute: async (input: Record<string, unknown>, options) => {
      const { action, ...args } = input;
      const name = `browser_${String(action)}`;
      const own = merged.includes(name) ? tools[name]! : null;
      if (!own?.execute) throw new Error(`No browser action "${String(action)}". Actions: ${actions.join(", ")}.`);
      const parsed = (own.inputSchema as unknown as z.ZodType).safeParse(args);
      if (!parsed.success) throw new Error(`${String(action)} needs ${shape(name)}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`);
      return own.execute(parsed.data, options);
    },
  });
  return { ...Object.fromEntries(Object.entries(tools).filter(([n]) => !merged.includes(n))), browser };
}
