import type { DiffFile } from "@drimvox/shared";
import { parseDiff } from "../agent/diff";
import { runGit } from "../agent/git";

/** git's empty tree: what a folder without commits is compared with. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** New files shown at most; more are rarely read and slow to diff. */
const MAX_NEW = 200;

/**
 * What the agent changed in the project's folder (docs/specs/project-work.md): every edit since the last commit, new
 * files included, without touching git's index; the user commits.
 */
export async function folderChanges(folder: string): Promise<DiffFile[]> {
  const head = (await runGit(folder, ["rev-parse", "--verify", "-q", "HEAD"], true)).code === 0 ? "HEAD" : EMPTY_TREE;
  const tracked = (await runGit(folder, ["diff", "--no-color", "--no-ext-diff", "--find-renames", head], true)).stdout;
  const untracked = (await runGit(folder, ["ls-files", "--others", "--exclude-standard", "-z"], true)).stdout.split("\0").filter(Boolean).slice(0, MAX_NEW);
  const added: string[] = [];
  for (const path of untracked) {
    // --no-index answers 1 when the files differ, which they always do here.
    const res = await runGit(folder, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", path], true);
    added.push(res.stdout.replace(/^diff --git a\/.+? b\//m, `diff --git a/${path} b/`));
  }
  return parseDiff([tracked, ...added].join("\n"));
}
