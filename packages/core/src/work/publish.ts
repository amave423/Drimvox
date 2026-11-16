import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeOf } from "../agent/store";
/**
 * Commands that publish the work: a release, a package, a deploy to a server. While Drimvox's tester has not yet tried
 * the turn's work, they wait (seen live: the rule "publish nothing before a clean check" was in the agent's instructions,
 * and it released Nexus 0.7.0 in the same answer anyway; asked for: rules kept by Drimvox, not left to the model).
 */
export const PUBLISHES =
  /\bgh\s+release\s+(create|upload|edit)\b|\bnpm\s+publish\b|\bdocker\s+push\b|\b(vercel|netlify)\b[^\n]*\bdeploy\b|\bgit\s+push\b[^\n;|&]*(--tags\b|refs\/tags\/)|\bsystemctl\s+(restart|reload|start)\b|\bpm2\s+(restart|reload|start)\b|^ssh_upload\b/i;

/** What the agent is told instead of running it. */
export const HELD =
  "Not yet: Drimvox's tester tries this turn's work first, and you are told to publish right after a clean check, in this same turn. Finish the work and reply that it is ready. Do not tell the user that Drimvox blocks or refuses the release: it goes out once the check is clean.";

/**
 * The project's files as the tester last found them clean, kept in Drimvox's data for the folder. A release asked for
 * with nothing changed since goes out at once (seen live: Nexus 0.8.0, checked clean, held again on each of the
 * user's three "where is the release?").
 */
const checkedFile = (folder: string) => join(storeOf(folder), "checked-tree.txt");

export function keepChecked(folder: string, tree: string): void {
  try {
    writeFileSync(checkedFile(folder), tree);
  } catch {
    // Not kept: the next release waits for a check again.
  }
}

export function lastChecked(folder: string): string | null {
  try {
    return existsSync(checkedFile(folder)) ? readFileSync(checkedFile(folder), "utf8").trim() || null : null;
  } catch {
    return null;
  }
}

/** After a turn that changed no files: nothing to check, the release or deploy that waited goes out now. */
export const NOTHING_TO_CHECK =
  "[Drimvox: this turn changed no files, so there is nothing for the tester to try.] If the user asked to publish (a release, a deploy, an upload), do it now. Otherwise reply in one line that it is done.";
