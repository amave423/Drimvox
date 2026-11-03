import { tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * Tools a coding agent seldom needs: kept out of every step until the model loads them (as Codex's tool_search). Measured:
 * 41 tools, 22 000 characters of their descriptions with every step, before the browser's 25 and the user's MCP servers.
 */
const RARE = /^(downloads_|email_|app_|ssh_)/;
const RARE_NAMES = new Set([
  "read_image_text",
  "audit_dependencies",
  "transcribe_media",
  "media_edit",
  "page_snapshot",
  "page_compare",
  "page_match_design",
  "icons_from_logo",
  "load_test",
  "dev_environment",
  "browser_network",
  "browser_performance",
  "browser_audit",
  "browser_pdf",
  "browser_upload",
  "browser_hover",
]);

export const isRare = (name: string) => RARE.test(name) || RARE_NAMES.has(name);

/** Fewer than this many rare tools are not worth a step to load them: all are sent. */
const MIN_RARE = 4;

/**
 * The tools with find_tools added, and which of them go with the next step: the usual ones, and the rare ones the model
 * has loaded. The list of rare names stays in find_tools' description, the same for the whole pass, so the provider's
 * cache holds until one is loaded.
 */
export function deferTools(tools: ToolSet): { tools: ToolSet; active(): string[] | undefined } {
  const rare = Object.keys(tools).filter(isRare);
  if (rare.length < MIN_RARE) return { tools, active: () => undefined };
  const loaded = new Set<string>();
  const first = (name: string) => `${name}: ${String(tools[name]!.description ?? "").split(/(?<=\.)\s/)[0]}`;
  const find_tools = tool({
    description:
      "Load tools that are not sent by default, by name or by a word of what they do, then call them in your next step. " +
      `They are: ${rare.join(", ")}.`,
    inputSchema: z.object({ names: z.array(z.string()).max(20).optional(), query: z.string().max(100).optional() }),
    execute: async ({ names, query }) => {
      const q = query?.trim().toLowerCase();
      const found = rare.filter((n) => names?.includes(n) || (!!q && (n.includes(q) || String(tools[n]!.description ?? "").toLowerCase().includes(q))));
      for (const n of found) loaded.add(n);
      return found.length ? `Loaded; call them now:\n${found.map(first).join("\n")}` : `None found. The tools to load are: ${rare.join(", ")}.`;
    },
  });
  return {
    tools: { ...tools, find_tools },
    active: () => [...Object.keys(tools).filter((n) => !rare.includes(n) || loaded.has(n)), "find_tools"],
  };
}
