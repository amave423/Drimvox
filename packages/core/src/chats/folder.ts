import type { StreamEvent } from "@artel/shared";
import type { ToolSet } from "ai";
import { buildTools, type ToolHooks } from "../agent/tools";
import { Workspace } from "../agent/workspace";

/** Steps one answer may take in a folder: enough to read, change, run and check; then "go on" continues. */
export const FOLDER_STEPS = 40;

/**
 * The agent's tools for a chat with a folder (docs/specs/chat-folder.md): the model reads, writes and runs commands
 * right in the user's folder, never outside it; risky commands ask in the answer. There is no "finish": the answer ends
 * when the model stops calling tools.
 */
export function folderTools(folder: string, emit: (event: StreamEvent) => Promise<void>, askApproval: ToolHooks["askApproval"]): ToolSet {
  const hooks: ToolHooks = {
    onCall: (call) => void emit({ type: "tool", name: call.name, input: describe(call.input) }),
    onResult: () => {},
    onFinish: () => {},
    askApproval,
  };
  const { finish: _finish, ...tools } = buildTools(new Workspace(folder), hooks, "write");
  return tools;
}

/** What the activity line shows of a call: the file, the command or the search. */
function describe(input: unknown): string {
  const i = (input ?? {}) as { path?: unknown; command?: unknown; pattern?: unknown };
  const text = typeof i.command === "string" ? i.command : typeof i.pattern === "string" ? i.pattern : typeof i.path === "string" ? i.path : "";
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
  ].join("\n");
}
