import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRepoRoot, runGit } from "./git";

/**
 * Where a project's folder went after it was renamed or moved beside where it was (seen live: three project folders
 * renamed on the desktop, and every project asked to turn git on again). Its conversation leaves marks in the folder's
 * git (refs/drimvox/chat/<chat>, the "Undo" points of its answers): the one folder next door with marks of the project's
 * conversations is it. Null when there is none, or more than one.
 */
export async function findMovedFolder(oldPath: string, chatIds: string[]): Promise<string | null> {
  const parent = dirname(oldPath);
  if (!chatIds.length || parent === oldPath || !existsSync(parent)) return null;
  let names: string[];
  try {
    names = readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return null;
  }
  const found: string[] = [];
  for (const name of names) {
    const dir = join(parent, name);
    if (!existsSync(join(dir, ".git")) || !(await isRepoRoot(dir).catch(() => false))) continue;
    const refs = await runGit(dir, ["for-each-ref", "--format=%(refname)", "refs/drimvox/chat"], true).catch(() => null);
    if (refs && chatIds.some((id) => refs.stdout.includes(`refs/drimvox/chat/${id}/`))) found.push(dir);
  }
  return found.length === 1 ? found[0]! : null;
}
