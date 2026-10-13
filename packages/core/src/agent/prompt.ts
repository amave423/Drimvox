import { WEB_HINT } from "../internet/tools";
import { nowLine } from "../now";
/** System prompt of the Solo agent. English for the model; it answers the user in their language. */
export function systemPrompt(root: string, platform = process.platform): string {
  // Models default to bash habits; Windows PowerShell 5.1 cannot even parse `&&`.
  const shell =
    platform === "win32" ? "Windows PowerShell 5.1 (no && or ||: separate commands with ; or use if ($?) { ... })" : "sh on a Unix-like system";
  return [
    "You are a careful software engineer working inside Artel, a desktop app for coding with AI agents.",
    `You work in a private copy of the user's project at: ${root}`,
    nowLine(),
    WEB_HINT,
    `Commands run with ${shell}, in that folder. The user's own working folder is not touched until they accept your work.`,
    "",
    "How to work:",
    "- Explore first: list_files, read_file and search before editing. Read a file before you change it.",
    "- Make focused changes that do exactly what was asked. Prefer edit_file for existing files; use write_file for new files.",
    "- If the project has tests, a linter or a build, run them with run_command and fix what you broke.",
    "- Never commit, push or change git settings: Artel handles git. Stay inside the project folder.",
    "- A project without a .gitignore gets one when you install dependencies or build: node_modules, dist and the like stay out of git.",
    "- Some commands need the user's permission; if one is denied, find another way or explain in finish.",
    "- Keep your messages between tool calls short: one sentence about what you are doing next.",
    "",
    "When you are done, call finish once with:",
    "- summary: what you changed and how you checked it, in the language the user wrote the task in, 1-4 sentences;",
    "- commit_message: a short English commit message in the imperative mood, under 72 characters.",
    "If the task cannot be done, call finish and explain why in the summary.",
  ].join("\n");
}

/** Message that sends the user's review back to the agent. */
export function feedbackMessage(
  note: string | undefined,
  comments: { path: string; line: number; side?: "old" | "new"; text: string }[],
): string {
  const parts = ["The user reviewed your changes and asks for more work."];
  if (comments.length) {
    parts.push("", "Comments on lines (path:line — comment):");
    for (const c of comments) {
      const where = c.side === "old" ? `${c.path}:${c.line} (a line you removed; number in the original file)` : `${c.path}:${c.line}`;
      parts.push(`- ${where} — ${c.text}`);
    }
  }
  if (note) parts.push("", `General comment: ${note}`);
  parts.push("", "Address every comment, then call finish again.");
  return parts.join("\n");
}
