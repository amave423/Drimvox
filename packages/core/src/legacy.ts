import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

/** The database's file before the app was renamed from Artel to Drimvox. */
const OLD_DB = "artel.db";
export const DB_FILE = "drimvox.db";

/**
 * What the app kept under its old name comes along on the first start after the rename: the database with its journal.
 * A database that already has the new name is left alone. Never throws: a file that cannot move stays where it is.
 */
export function moveLegacyData(dataDir: string): void {
  if (existsSync(join(dataDir, DB_FILE)) || !existsSync(join(dataDir, OLD_DB))) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(dataDir, OLD_DB + suffix);
    if (!existsSync(from)) continue;
    try {
      renameSync(from, join(dataDir, DB_FILE + suffix));
    } catch {
      // Held by another process: the next start tries again.
      return;
    }
  }
}
