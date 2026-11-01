import { tool, type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";
import type { Workspace } from "../agent/workspace";
import { extract } from "../chats/attachments";
import type { Vision } from "../visual/look";
import { readImageText } from "./ocr";

/** Where the agent's browser saves what it downloads (the desktop's tab and the server's Chrome alike). */
export const downloadsDir = (dataDir: string) => join(dataDir, "browser-downloads");

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;

/**
 * Files the agent downloaded in its browser (docs/specs/agent-browser.md, asked for: a "Download" left the file where the
 * agent could not see it): the list, the text of one (PDF, ZIP, text files; a picture's text read off it), and a copy
 * into the folder. Pictures in the folder are read the same way (read_image_text).
 */
export function downloadTools(dataDir: string, ws: Workspace | null, vision: Vision | null, hooks: Pick<ToolHooks, "onCall">): ToolSet {
  const dir = downloadsDir(dataDir);
  const files = () =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => !n.endsWith(".crdownload") && statSync(join(dir, n)).isFile())
          .map((n) => ({ name: n, size: statSync(join(dir, n)).size, at: statSync(join(dir, n)).mtimeMs }))
          .sort((a, b) => b.at - a.at)
      : [];
  const pick = (name: string) => {
    const found = files().find((f) => f.name === name) ?? files().find((f) => f.name.toLowerCase().includes(name.toLowerCase()));
    if (!found) throw new Error(`No downloaded file "${name}". Downloaded: ${files().slice(0, 20).map((f) => f.name).join(", ") || "nothing yet"}.`);
    return join(dir, found.name);
  };
  const run = async (name: string, input: string, work: () => Promise<string>) => {
    hooks.onCall({ callId: randomUUID(), name, input });
    try {
      return await work();
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const textOf = async (path: string, signal?: AbortSignal) => {
    const data = readFileSync(path);
    if (IMAGE.test(path)) {
      const read = await readImageText(path, data, vision, signal);
      return `Text on the picture (read by ${read.by}):\n${read.text}`;
    }
    const got = await extract(basename(path), "", data);
    if (got.text === null) return `${basename(path)} has no text Drimvox can read (a scanned PDF without text, or a binary file).`;
    return got.text;
  };

  return {
    downloads_list: tool({
      description: "The files you downloaded in the browser, the newest first, with their size and when.",
      inputSchema: z.object({}),
      execute: () =>
        run("downloads_list", "", async () => {
          const list = files();
          if (!list.length) return "Nothing downloaded yet. A link or button that downloads saves its file here.";
          return list.slice(0, 50).map((f) => `${f.name} · ${Math.max(1, Math.round(f.size / 1024))} KB · ${new Date(f.at).toLocaleString()}`).join("\n");
        }),
    }),
    downloads_read: tool({
      description: "Read a downloaded file: the text of a PDF, a ZIP's files, a text, CSV or JSON file, or the text on a downloaded picture or scan.",
      inputSchema: z.object({ name: z.string().min(1).describe("The file's name from downloads_list") }),
      execute: ({ name }, o: { abortSignal?: AbortSignal }) => run("downloads_read", name, () => textOf(pick(name), o.abortSignal)),
    }),
    ...(ws
      ? {
          downloads_save: tool({
            description: "Copy a downloaded file into the folder (the chat's or the project's), at a path inside it.",
            inputSchema: z.object({ name: z.string().min(1), path: z.string().min(1).describe("Where to put it inside the folder") }),
            execute: ({ name, path }) =>
              run("downloads_save", `${name} → ${path}`, async () => {
                const target = ws.resolve(path);
                mkdirSync(dirname(target), { recursive: true });
                copyFileSync(pick(name), target);
                return `Copied to ${path}.`;
              }),
          }),
          read_image_text: tool({
            description: "Read the text on a picture or a scan in the folder (a photo of a document, a screenshot, a receipt): all of it, as it is written.",
            inputSchema: z.object({ path: z.string().min(1) }),
            execute: ({ path }, o: { abortSignal?: AbortSignal }) =>
              run("read_image_text", path, async () => {
                const full = ws.resolve(path);
                const read = await readImageText(full, readFileSync(full), vision, o.abortSignal);
                return `Text on the picture (read by ${read.by}):\n${read.text}`;
              }),
          }),
        }
      : {}),
  };
}
