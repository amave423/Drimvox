import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { pageStepsInput } from "../visual/steps";
import { clipPage, isPublicAddress, type WebAccess } from "./web";

/** What a model sees from the internet tools; also what the chat shows while it searches. */
export interface WebCall {
  callId: string;
  name: "web_search" | "open_page" | "browse_page";
  input: string;
}

export interface WebHooks {
  onCall?(call: WebCall): void;
  onResult?(result: { callId: string; name: string; ok: boolean; output: string }): void;
}

/** Seen live: a model met a site's bot check (a proof-of-work captcha) and started computing its answer to get through. */
export const FAIR_USE_HINT =
  "Never try to get around captchas, bot checks, logins or blocks of a site (no solving them, no imitating a person, no other mirrors to dodge a block): say what blocks you and offer another way.";

export const WEB_HINT =
  "You can use the internet: web_search finds pages, open_page reads one. Use them for current facts (news, prices, " +
  "weather, versions, documentation) instead of guessing, and name the sources you used. When open_page shows little or " +
  "\"Loading…\" (a site that draws with scripts: databases, shops, search forms), use browse_page if you have it: a real " +
  "browser that can also type into a search field, press a button and wait before reading. Search sparingly: a few " +
  "precise queries, then open the pages; when you know the site that has the answer, go to it directly. " +
  FAIR_USE_HINT;

/** Search and page reading, free, through Artel itself; for any model that can call tools. */
export function webTools(web: WebAccess, hooks: WebHooks = {}): ToolSet {
  // Within one answer: a query asked again is answered from what was found (DuckDuckGo limits bursts), and a browser
  // call that failed twice exactly as it is is not tried a third time (seen: the same missing field, twelve times).
  const found = new Map<string, string>();
  const failed = new Map<string, number>();
  const run = async (callId: string, name: WebCall["name"], input: string, work: () => Promise<string>) => {
    hooks.onCall?.({ callId, name, input });
    let ok = true;
    let output: string;
    try {
      output = await work();
    } catch (err) {
      ok = false;
      output = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    hooks.onResult?.({ callId, name, ok, output: output.slice(0, 4000) });
    return output;
  };
  const tools: ToolSet = {
    web_search: tool({
      description: "Search the internet. Returns titles, addresses and short snippets of the top results.",
      inputSchema: z.object({ query: z.string().min(1).max(400) }),
      execute: ({ query }, o: { toolCallId: string; abortSignal?: AbortSignal }) =>
        run(o.toolCallId, "web_search", query, async () => {
          const key = query.trim().toLowerCase();
          const known = found.get(key);
          if (known !== undefined) return known;
          const text = (await web.search(query, o.abortSignal)).map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n");
          found.set(key, text);
          return text;
        }),
    }),
    open_page: tool({
      description: "Open a public web page and read its text.",
      inputSchema: z.object({ url: z.string().url().max(2000) }),
      execute: ({ url }, o: { toolCallId: string; abortSignal?: AbortSignal }) =>
        run(o.toolCallId, "open_page", url, async () => {
          const page = await web.open(url, o.abortSignal);
          return `${page.title ? `${page.title}\n` : ""}${page.url}\n\n${page.text}`;
        }),
    }),
  };
  const render = web.render;
  if (!render) return tools;
  tools.browse_page = tool({
    description:
      "Open a public page in a real browser, run its scripts, optionally do steps first (type into a field by its label or " +
      "placeholder, click a button or link by its text, press a key, wait), then read the text the page shows.",
    inputSchema: z.object({ url: z.string().url().max(2000), steps: pageStepsInput.describe("Done in order before reading") }),
    execute: ({ url, steps }, o: { toolCallId: string; abortSignal?: AbortSignal }) =>
      run(o.toolCallId, "browse_page", url, async () => {
        if (!isPublicAddress(url)) throw new Error("Only public internet addresses can be opened");
        const key = JSON.stringify({ url, steps });
        if ((failed.get(key) ?? 0) >= 2) {
          throw new Error(
            "This exact call already failed twice. Change the steps (use the field and button names the error listed), try another page, or tell the user what blocks you.",
          );
        }
        try {
          const page = await render(url, steps, o.abortSignal);
          return `${page.title ? `${page.title}\n` : ""}${page.url}\n\n${clipPage(page.text)}`;
        } catch (err) {
          failed.set(key, (failed.get(key) ?? 0) + 1);
          throw err;
        }
      }),
  });
  return tools;
}
