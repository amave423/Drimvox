import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentFileNames } from "@drimvox/shared";
import { storeOf } from "./store";

/**
 * The project's notes for agents, sent whole at the start of every request and never summarized. The user's own
 * AGENTS.md (or CLAUDE.md) is read as it is; what Drimvox writes — the agent's notes (update_notes) and the project's
 * state — is kept in Drimvox's data (store.ts), not in the project (asked for: no files of Drimvox's there).
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
  moveOut(root);
  const store = storeOf(root);
  const own = ["AGENTS.md", "CLAUDE.md"].find((name) => existsSync(join(root, name)));
  const parts: string[] = [];
  if (own) {
    const text = readFileSync(join(root, own), "utf8").trim();
    if (text) parts.push(`The project's ${own}:\n${text.length > FILE_LIMIT ? `${text.slice(0, FILE_LIMIT)}\n…` : text}`);
  }
  for (const [file, title] of [
    [NOTES, "Your notes on this project, kept by Drimvox outside the project (update_notes changes them)"],
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

/** Pointer files Drimvox once made for other agents, by their exact text: removed with the sections they pointed to. */
const IMPORT_POINTER = "@AGENTS.md\n";
const WORD_POINTER = "Read AGENTS.md in the project root first: the project's rules, state, plan and notes, kept current by Drimvox.\n";
const POINTER_FILES = Object.values(agentFileNames);

/**
 * What earlier versions wrote into the project: Drimvox's sections of AGENTS.md go to its data, the file goes when
 * nothing of the user's is left, and so do the pointer files made for other agents.
 */
function moveOut(root: string): void {
  const file = join(root, "AGENTS.md");
  if (!existsSync(file)) return;
  let text = readFileSync(file, "utf8");
  if (!text.includes(START) && !text.includes(STATE_START)) return;
  const store = storeOf(root);
  for (const [open, close, name] of [
    [START, END, NOTES],
    [STATE_START, STATE_END, STATE],
  ] as const) {
    const at = text.indexOf(open);
    const end = text.indexOf(close);
    if (at < 0 || end < at) continue;
    const body = text.slice(at + open.length, end).trim();
    if (body && !existsSync(join(store, name))) writeFileSync(join(store, name), `${body}\n`);
    text = text.slice(0, at) + text.slice(end + close.length);
  }
  if (text.replace(/^\s*# Notes for agents\s*/, "").trim()) {
    writeFileSync(file, `${text.trim()}\n`);
    return;
  }
  rmSync(file, { force: true });
  for (const path of POINTER_FILES.map((n) => join(root, n))) {
    if (!existsSync(path)) continue;
    const body = readFileSync(path, "utf8");
    if (body === IMPORT_POINTER || body === WORD_POINTER) rmSync(path, { force: true });
  }
}
