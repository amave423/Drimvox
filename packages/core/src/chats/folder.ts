import type { AttachmentView, StreamEvent } from "@drimvox/shared";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { buildTools, type ToolHooks } from "../agent/tools";
import { Workspace } from "../agent/workspace";
import { askAboutPictures, type Vision } from "../visual/look";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

/** Steps one answer may take in a folder: a whole piece of work (seen live: 40 stopped four answers of thirteen mid-way). */
export const FOLDER_STEPS = 100;

/** The files attached in the chat, for save_attachment. */
export interface ChatFiles {
  list(): AttachmentView[];
  file(id: string): Buffer;
}

/**
 * The agent's tools for a chat with a folder (docs/specs/chat-folder.md): the model reads, writes and runs commands
 * right in the user's folder, never outside it; risky commands ask in the answer. There is no "finish": the answer ends
 * when the model stops calling tools.
 */
export function folderTools(
  folder: string,
  emit: (event: StreamEvent) => Promise<void>,
  askApproval: ToolHooks["askApproval"],
  files?: ChatFiles,
  /** A model that sees pictures: look_at_image shows it pictures of the folder. */
  vision?: Vision | null,
): ToolSet {
  const hooks: ToolHooks = {
    onCall: (call) => void emit({ type: "tool", name: call.name, input: describeCall(call.input) }),
    onResult: () => {},
    onFinish: () => {},
    askApproval,
  };
  const ws = new Workspace(folder);
  const { finish: _finish, ...tools } = buildTools(ws, hooks, "write");
  if (vision) tools.look_at_image = lookAtImage(ws, vision, emit);
  if (!files) return tools;
  // "Here is a picture, put it on the site": the files the user attached go into the folder on request.
  tools.save_attachment = tool({
    description: "Save a file the user attached in this chat into the folder, at a path inside it.",
    inputSchema: z.object({ name: z.string().min(1).describe("The attached file's name"), path: z.string().min(1).describe("Where to put it, inside the folder") }),
    execute: async ({ name, path }) => {
      void emit({ type: "tool", name: "save_attachment", input: path });
      const found = [...files.list()].reverse().find((a) => a.name === name);
      if (!found) return `No attached file named ${name}. Attached: ${files.list().map((a) => a.name).join(", ") || "none"}.`;
      try {
        ws.writeBytes(path, files.file(found.id));
        return `Saved ${name} as ${path}.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
  return tools;
}

const PICTURES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
/** Larger pictures cost much and say little more. */
const MAX_PICTURE = 8 * 1024 * 1024;

/**
 * A picture of the folder shown to a model that sees pictures (seen live: a model that sees them said it could not, and
 * measured pixels with scripts). Asked aside: OpenAI-style providers take only text back from a tool.
 */
function lookAtImage(ws: Workspace, vision: Vision, emit: (event: StreamEvent) => Promise<void>) {
  return tool({
    description: "Look at a picture in the folder (png, jpg, webp, gif) and ask about it: what is on it, its colours, shapes, text.",
    inputSchema: z.object({ path: z.string().min(1), question: z.string().min(1).max(2000) }),
    execute: async ({ path, question }, o: { abortSignal?: AbortSignal }) => {
      void emit({ type: "tool", name: "look_at_image", input: path });
      const type = PICTURES[extname(path).toLowerCase()];
      if (!type) return `Error: ${path} is not a picture Drimvox can show (png, jpg, webp, gif).`;
      try {
        const data = readFileSync(ws.resolve(path));
        if (data.length > MAX_PICTURE) return `Error: ${path} is larger than 8 MB.`;
        const prompt = `${question}\nAnswer concretely, in the language of the question.`;
        return (await askAboutPictures(vision, [{ data, mediaType: type }], prompt, o.abortSignal)).text;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

/** What the activity line shows of a call: the file, the command or the search. */
export function describeCall(input: unknown): string {
  if (typeof input === "string") return input.length > 200 ? `${input.slice(0, 200)}…` : input;
  const i = (input ?? {}) as Record<string, unknown>;
  const text = [i.command, i.pattern, i.url, i.query, i.path, i.name].find((v): v is string => typeof v === "string") ?? "";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** What the model is told when the chat has a folder. */
export function folderHint(folder: string, platform = process.platform): string {
  const shell = platform === "win32" ? "Windows PowerShell 5.1 (no && or ||: separate commands with ;)" : "sh";
  return [
    `The user connected a folder to this chat: ${folder}. You work right in it: what you write changes the user's files at once.`,
    `Commands run with ${shell} in that folder. Read files with read_file and search, not with commands; change them with`,
    "edit_file (or write_file for new ones). Do what the user asks, run the project's checks when you change code, and say",
    "briefly what you changed. Never commit or push: the user keeps git. Keep the project's notes current with update_notes",
    "when you learn something the next conversation must know.",
    // Seen live: a model drove a hidden Word through COM; it waited for an answer nobody could give, for two hours.
    "Office files (.docx, .xlsx, .pptx) are made with libraries: python-docx, openpyxl, python-pptx (or docx, exceljs,",
    "pptxgenjs in Node). Never drive Word, Excel, PowerPoint or Outlook through COM automation or New-Object -ComObject:",
    "hidden Office windows wait for answers nobody can give, and the command hangs.",
    "To see a picture in the folder, use look_at_image when you have it; never guess a picture from its pixels with scripts.",
  ].join("\n");
}
