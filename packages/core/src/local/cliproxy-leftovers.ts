import type { Database } from "../db";
import { removeTree } from "../fsx";
import type { ProviderRepo } from "../providers/repo";

const KEY = "cliproxy";

/**
 * Earlier versions could run CLIProxyAPI for sign-ins with one's subscriptions; it is gone now (asked for: the app does
 * all of it itself). Once, at start: its provider, program and settings are removed. A server it left running is not
 * stopped by its old process id: after a restart that number may belong to another program.
 */
export function forgetCliProxy(db: Database, providers: Pick<ProviderRepo, "get" | "remove">, dir: string): void {
  const row = db.sql.prepare("select value from settings where key = ?").get(KEY) as { value: string } | undefined;
  if (!row) return;
  let kept: { providerId?: string | null } = {};
  try {
    kept = JSON.parse(row.value) as typeof kept;
  } catch {
    // Unreadable: only the setting goes.
  }
  if (kept.providerId && providers.get(kept.providerId)) providers.remove(kept.providerId);
  try {
    removeTree(dir);
  } catch {
    // A file still held: the folder stays, nothing uses it.
  }
  db.sql.prepare("delete from settings where key = ?").run(KEY);
}
