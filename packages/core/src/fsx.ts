import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/*
 * Node 24.11 on Windows silently keeps files with fs.rmSync and fails fs.cpSync on paths with non-ASCII
 * letters, such as a Cyrillic user folder (checked 2026-10-12). These do the same with the plain calls that work.
 */

/** Copies a folder with everything in it. Links are skipped. */
export function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) copyFileSync(source, target);
  }
}

/** Deletes a folder or a file and everything in it; nothing happens when it is not there. */
export function removeTree(path: string): void {
  if (!existsSync(path)) return;
  if (!lstatSync(path).isDirectory()) return unlinkSync(path);
  for (const entry of readdirSync(path)) removeTree(join(path, entry));
  rmdirSync(path);
}
