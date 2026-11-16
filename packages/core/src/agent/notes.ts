import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeOf } from "./store";

/**
 * The project's notes for agents, sent whole at the start of every request and never summarized. The user's own
 * AGENTS.md (or CLAUDE.md) is read as it is; the agent's notes (update_notes) and the project's state are kept in
 * Drimvox's data (store.ts). In a project the notes are also copied into a section of its AGENTS.md (asked for on
 * 2026-11-16, after 2026-11-10's "no files of Drimvox's in the project": a new conversation or another agent such as
 * Codex or Claude Code goes on from them). The user's text in that file stays as it is.
 */
export const NOTES_LIMIT = 4000;
/** More of a user's own file than this is not sent. */
const FILE_LIMIT = 12_000;
const START = "<!-- drimvox -->";
const END = "<!-- /drimvox -->";
const STATE_START = "<!-- drimvox:state -->";
const STATE_END = "<!-- /drimvox:state -->";

const NOTES = "notes.md";
const STATE = "state.md";

/** The notes as the system prompt carries them; empty when the project has none yet. */
export function notesBlock(root: string): string {
  adoptOld(root);
  const store = storeOf(root);
  const parts: string[] = [];
  // The user's own file, without Drimvox's copy of the notes: they come below, once.
  const own = ["AGENTS.md", "CLAUDE.md"].find((name) => existsSync(join(root, name)) && withoutOurs(readFileSync(join(root, name), "utf8")).trim());
  if (own) {
    const text = withoutOurs(readFileSync(join(root, own), "utf8")).trim();
    if (text) parts.push(`The project's ${own}:\n${text.length > FILE_LIMIT ? `${text.slice(0, FILE_LIMIT)}\n…` : text}`);
  }
  for (const [file, title] of [
    // Seen live: a server address the agent got wrong and wrote here outweighed the user saying three times that it
    // was gone; each answer read it again as a fact.
    [
      NOTES,
      "Your notes on this project, kept by Drimvox outside the project. An earlier agent wrote them and they may be out of " +
        "date or wrong: what the user says in this conversation and what you check now come first. When either " +
        "contradicts a note, fix the note with update_notes at once",
    ],
    [STATE, "The project's state, kept by Drimvox"],
  ] as const) {
    const path = join(store, file);
    const text = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (text) parts.push(`${title}:\n${text}`);
  }
  return parts.join("\n\n");
}

/**
 * A password, key or token written out (seen live: "sudo password `…`" and "echo '…' | sudo -S" in AGENTS.md, which went
 * to a public repository): a secret word with a quoted value or one after = or :, or a password piped into sudo.
 */
const SECRET_WORD = "(?:парол\\p{L}*|password|passwd|pwd|token|токен\\p{L}*|api[ _-]?key|secret|секрет\\p{L}*)";
const QUOTED_SECRET = new RegExp(SECRET_WORD + "[^\\n`'\"]{0,16}[`'\"][^`'\"\\s]{4,}[`'\"]", "iu");
const ASSIGNED_SECRET = new RegExp(SECRET_WORD + "\\s*[:=]\\s*[^\\s,.;]{4,}", "iu");
const PIPED_SUDO = /echo\s+['"][^'"]+['"]\s*\|\s*sudo\s+-S/i;

export function holdsSecret(text: string): boolean {
  return QUOTED_SECRET.test(text) || ASSIGNED_SECRET.test(text) || PIPED_SUDO.test(text);
}

/** The agent's notes, replaced whole. */
export function writeNotes(root: string, notes: string): void {
  const body = notes.trim();
  if (body.length > NOTES_LIMIT) {
    throw new Error(`The notes are ${body.length} characters; make them shorter than ${NOTES_LIMIT}: keep what the next agent must know, drop history.`);
  }
  if (holdsSecret(body)) {
    throw new Error('The notes hold a password, key or token. Write only where the secret is kept ("the user knows the sudo password"), never the secret itself.');
  }
  writeFileSync(join(storeOf(root), NOTES), `${body}\n`);
}

/** What Drimvox knows of a project's work, written for whoever picks it up next. */
export interface ProjectState {
  goal: string;
  checklist: { text: string; done: boolean }[];
  start: { command: string; url: string } | null;
  branch: string | null;
  report: string | null;
  at: number;
}

/** The project's state, written by Drimvox itself after each turn of its agent, whatever the model remembered to note. */
export function writeState(root: string, s: ProjectState): void {
  const lines = [`Updated: ${new Date(s.at).toISOString().slice(0, 16).replace("T", " ")} UTC`, "", `Goal: ${s.goal.trim().split("\n")[0]!.slice(0, 400)}`];
  if (s.checklist.length) lines.push("", "Plan:", ...s.checklist.slice(0, 40).map((i) => `- [${i.done ? "x" : " "}] ${i.text}`));
  if (s.start) lines.push("", `Run: \`${s.start.command}\`, then open ${s.start.url}`);
  if (s.branch) lines.push("", `Git branch: ${s.branch}`);
  if (s.report) lines.push("", "Last report:", s.report.trim().slice(0, 1500));
  writeFileSync(join(storeOf(root), STATE), `${lines.join("\n")}\n`);
}

/** The project's AGENTS.md without Drimvox's sections: what the user wrote there. */
function withoutOurs(text: string): string {
  for (const [open, close] of [
    [START, END],
    [STATE_START, STATE_END],
  ] as const) {
    const at = text.indexOf(open);
    const end = text.indexOf(close);
    if (at >= 0 && end > at) text = text.slice(0, at) + text.slice(end + close.length);
  }
  return text.replace(/^\s*# Notes for agents\s*$/m, "").replace(/\n{3,}/g, "\n\n");
}

/** Notes an earlier version left in the project's AGENTS.md become Drimvox's own, when it has none yet. */
function adoptOld(root: string): void {
  const file = join(root, "AGENTS.md");
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const [open, close, name] of [
    [START, END, NOTES],
    [STATE_START, STATE_END, STATE],
  ] as const) {
    const at = text.indexOf(open);
    const end = text.indexOf(close);
    if (at < 0 || end < at) continue;
    const body = text.slice(at + open.length, end).trim();
    const path = join(storeOf(root), name);
    if (body && !existsSync(path)) writeFileSync(path, `${body}\n`);
  }
}

/**
 * The agent's notes copied into the project's AGENTS.md, in a section of their own, the user's text around it as it was.
 * Written when the agent changes its notes, so its own commit takes the file along.
 */
export function mirrorNotes(root: string): void {
  const path = join(storeOf(root), NOTES);
  const notes = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (!notes) return;
  const file = join(root, "AGENTS.md");
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  const own = withoutOurs(old).trim();
  const section = [
    START,
    "## Notes for agents",
    "Kept by the agent that builds this project in Drimvox, rewritten as the work goes on. Anyone continuing here (a new",
    "conversation, Codex, Claude Code) reads this first; what the user says now comes before it.",
    "",
    notes,
    END,
  ].join("\n");
  const next = own ? `${own}\n\n${section}\n` : `${section}\n`;
  if (next !== old) writeFileSync(file, next);
}

/** Whether the agent changed its notes after this moment. */
export function notesChangedSince(root: string, since: number): boolean {
  try {
    return statSync(join(storeOf(root), NOTES)).mtimeMs >= since;
  } catch {
    return false;
  }
}
