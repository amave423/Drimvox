import { existsSync, renameSync } from "node:fs";

/**
 * The app's data folder after the rename from Artel to Drimvox: the old folder becomes the new one on the first start,
 * with the chats, keys and projects in it. When it cannot be moved (the old app still runs and holds it), the old folder
 * is used as it is: nothing is lost, and the next start tries again.
 */
export function dataFolder(current: string, old: string): string {
  if (existsSync(current) || !existsSync(old)) return current;
  try {
    renameSync(old, current);
    return current;
  } catch {
    return old;
  }
}
