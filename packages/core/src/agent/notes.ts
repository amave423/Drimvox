import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The project's notes for agents: AGENTS.md (or CLAUDE.md), sent whole at the start of every request and never
 * summarized, so what matters most is always at hand. The agent keeps its own section between markers short and
 * current with update_notes; the rest of the file is the user's.
 */
export const NOTES_LIMIT = 4000;
/** More of a user's own file than this is not sent. */
const FILE_LIMIT = 12_000;
const START = "<!-- artel -->";
const END = "<!-- /artel -->";

function notesFile(root: string): string | null {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) if (existsSync(join(root, name))) return join(root, name);
  return null;
}

/** The notes as the system prompt carries them; empty when the project has none yet. */
export function notesBlock(root: string): string {
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
  const file = join(root, "AGENTS.md");
  const section = `${START}\n${body}\n${END}`;
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  const at = old.indexOf(START);
  const end = old.indexOf(END);
  const next =
    at >= 0 && end > at
      ? `${old.slice(0, at)}${section}${old.slice(end + END.length)}`
      : old.trim()
        ? `${old.replace(/\s*$/, "\n")}\n${section}\n`
        : `# Notes for agents\n\n${section}\n`;
  writeFileSync(file, next);
}
