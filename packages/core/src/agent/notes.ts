import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The project's notes for agents: AGENTS.md (or CLAUDE.md), sent whole at the start of every request and never
 * summarized, so what matters most is always at hand. The agent keeps its own section between markers short and
 * current with update_notes; the rest of the file is the user's.
 */
export const NOTES_LIMIT = 4000;
/** More of a user's own file than this is not sent. */
const FILE_LIMIT = 12_000;
const START = "<!-- drimvox -->";
const END = "<!-- /drimvox -->";

function notesFile(root: string): string | null {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) if (existsSync(join(root, name))) return join(root, name);
  return null;
}

/** The notes as the system prompt carries them; empty when the project has none yet. */
export function notesBlock(root: string): string {
  // AGENTS.md first: a CLAUDE.md that only points to it adds nothing.
  const file = notesFile(root);
  if (!file) return "";
  const text = readFileSync(file, "utf8").trim();
  if (!text) return "";
  const shown = text.length > FILE_LIMIT ? `${text.slice(0, FILE_LIMIT)}\n…` : text;
  return `Project notes (${file.endsWith("CLAUDE.md") ? "CLAUDE.md" : "AGENTS.md"}), kept for every agent working here:\n${shown}`;
}

/** Replaces the agent's section of AGENTS.md, creating the file or the section when missing. */
export function writeNotes(root: string, notes: string): void {
  const body = notes.trim();
  if (body.length > NOTES_LIMIT) {
    throw new Error(`The notes are ${body.length} characters; make them shorter than ${NOTES_LIMIT}: keep what the next agent must know, drop history.`);
  }
  writeSection(root, START, END, body);
}

const STATE_START = "<!-- drimvox:state -->";
const STATE_END = "<!-- /drimvox:state -->";

/** What Drimvox knows of a project's work, written for whoever picks it up next. */
export interface ProjectState {
  goal: string;
  checklist: { text: string; done: boolean }[];
  start: { command: string; url: string } | null;
  branch: string | null;
  report: string | null;
  at: number;
}

/**
 * The project's state, written by Drimvox itself after each turn of its agent, whatever the model remembered to note
 * (asked for: any agent, in Drimvox or another program, picks the work up without explanations). AGENTS.md is the open
 * format most agents read; for those that read a file of their own, a short pointer is made when the settings ask for
 * it (CLAUDE.md, GEMINI.md, Copilot's, Windsurf's rules…) and the project has none.
 */
export function writeState(root: string, s: ProjectState, pointers: string[] = []): void {
  const lines = [
    "## Project state (kept by Drimvox)",
    "",
    `Updated: ${new Date(s.at).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `Goal: ${s.goal.trim().split("\n")[0]!.slice(0, 400)}`,
  ];
  if (s.checklist.length) lines.push("", "Plan:", ...s.checklist.slice(0, 40).map((i) => `- [${i.done ? "x" : " "}] ${i.text}`));
  if (s.start) lines.push("", `Run: \`${s.start.command}\`, then open ${s.start.url}`);
  if (s.branch) lines.push("", `Git branch: ${s.branch}`);
  if (s.report) lines.push("", "Last report:", s.report.trim().slice(0, 1500));
  lines.push("", "Next agent: read the notes above and this state, check the open plan items, then go on.");
  writeSection(root, STATE_START, STATE_END, lines.join("\n"));
  for (const name of pointers) {
    const file = join(root, name);
    if (existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, IMPORTS.has(name) ? "@AGENTS.md\n" : POINTER);
  }
}

/** Files whose agent includes another file by "@name"; the rest get the pointer in words. */
const IMPORTS = new Set(["CLAUDE.md", "GEMINI.md", "QWEN.md"]);
const POINTER = "Read AGENTS.md in the project root first: the project's rules, state, plan and notes, kept current by Drimvox.\n";

/** Replaces one marked section of AGENTS.md, creating the file or the section when missing. */
function writeSection(root: string, open: string, close: string, body: string): void {
  const file = join(root, "AGENTS.md");
  const section = `${open}\n${body}\n${close}`;
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  const at = old.indexOf(open);
  const end = old.indexOf(close);
  const next =
    at >= 0 && end > at
      ? `${old.slice(0, at)}${section}${old.slice(end + close.length)}`
      : old.trim()
        ? `${old.replace(/\s*$/, "\n")}\n${section}\n`
        : `# Notes for agents\n\n${section}\n`;
  writeFileSync(file, next);
}
