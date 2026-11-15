import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeOf } from "../agent/store";

/**
 * What helps the tester spend its steps on testing (asked for: "the tester catches too little"; seen live: more than half
 * of its steps went on finding how to start the project, and a run of it ended before it looked at the installer).
 */

/** Files that draw what the user sees. */
const SCREEN = /\.(svelte|vue|[jt]sx|html|css|scss|less)$/i;

/** The interface files a unified diff changed, at most `limit`. */
export function changedScreens(patch: string, limit = 20): string[] {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(.+?) b\//gm)) if (SCREEN.test(m[1]!)) files.add(m[1]!);
  return [...files].slice(0, limit);
}

/** How the last tester started this project, kept in Drimvox's own data for the folder, not in the project. */
const recipeFile = (folder: string) => join(storeOf(folder), "tester-start.txt");

export function readRecipe(folder: string): string {
  try {
    const file = recipeFile(folder);
    return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  } catch {
    return "";
  }
}

export function keepRecipe(folder: string, text: string | undefined): void {
  if (!text?.trim()) return;
  try {
    writeFileSync(recipeFile(folder), text.trim().slice(0, 2000));
  } catch {
    // Not kept: the next tester finds the way itself.
  }
}
