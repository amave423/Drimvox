import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Where Drimvox keeps what it writes about a folder: the agent's notes, the project's state, long command outputs.
 * Asked for: none of it in the user's project (it was AGENTS.md and .drimvox there); it lives in Drimvox's data, a
 * folder per project folder. The app sets the place at start; tests get a temporary one.
 */
let root = join(tmpdir(), "drimvox-projects");

export function setStoreDir(dir: string): void {
  root = dir;
}

/** The folder for one project folder: its name and a short hash of its full path, made when missing. */
export function storeOf(folder: string): string {
  const full = resolve(folder);
  const key = createHash("sha1").update(process.platform === "win32" ? full.toLowerCase() : full).digest("hex").slice(0, 12);
  const dir = join(root, `${basename(full).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 40) || "folder"}-${key}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
