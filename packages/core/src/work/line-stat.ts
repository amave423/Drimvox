import { existsSync, readFileSync, statSync } from "node:fs";
import { Workspace } from "../agent/workspace";

/** Files larger than this are not read to count what a write changed. */
const MAX_READ = 2_000_000;

const linesOf = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "")
    .split("\n")
    .filter((_, i, all) => all.length > 1 || all[0] !== "");

/** Lines in `after` that `before` has not (added) and the other way round (removed), as a bag of lines. */
function diffCount(before: string[], after: string[]): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added++;
  }
  const removed = [...counts.values()].reduce((sum, n) => sum + n, 0);
  return { added, removed };
}

/**
 * The lines a write or an edit adds and removes, counted before it runs (asked for: changed files shown where the agent
 * changed them, with how many lines went in and out). Null for other tools, or what cannot be read.
 */
export function lineStat(
  folder: string,
  name: string,
  input: unknown,
): { added: number; removed: number; perFile?: Record<string, { added: number; removed: number }> } | null {
  const i = (input ?? {}) as Record<string, unknown>;
  try {
    if (name === "write_file" && typeof i.path === "string" && typeof i.content === "string") {
      const file = new Workspace(folder).resolve(i.path);
      const before = existsSync(file) && statSync(file).size <= MAX_READ ? readFileSync(file, "utf8") : "";
      return diffCount(linesOf(before), linesOf(i.content));
    }
    if (name === "edit_file") {
      const edits = [
        ...(typeof i.old === "string" && typeof i.new === "string" ? [{ old: i.old, new: i.new, path: i.path }] : []),
        ...(Array.isArray(i.edits) ? (i.edits as { old?: unknown; new?: unknown; path?: unknown }[]) : []),
      ].filter((e): e is { old: string; new: string; path?: unknown } => typeof e.old === "string" && typeof e.new === "string");
      if (!edits.length) return null;
      // Each file's own lines (seen: one call changed two files, and both showed only "changed").
      const perFile: Record<string, { added: number; removed: number }> = {};
      for (const e of edits) {
        const path = typeof e.path === "string" ? e.path : typeof i.path === "string" ? i.path : "";
        const d = diffCount(linesOf(e.old), linesOf(e.new));
        const had = perFile[path] ?? { added: 0, removed: 0 };
        perFile[path] = { added: had.added + d.added, removed: had.removed + d.removed };
      }
      const total = Object.values(perFile).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }));
      return Object.keys(perFile).length > 1 ? { ...total, perFile } : total;
    }
  } catch {
    return null;
  }
  return null;
}
