import { randomUUID } from "node:crypto";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRepoRoot, runGit, withoutDependencies } from "../agent/git";

/**
 * Snapshots of a chat's folder before each answer, so one button undoes what the model did (docs/specs/chat-folder.md).
 * A snapshot is a commit built in a temporary index and kept under refs/drimvox/chat/…: the user's branches, history,
 * index and files stay as they are. Ignored files and dependency folders are not part of it and are never touched.
 */
const DRIMVOX = { GIT_AUTHOR_NAME: "Drimvox", GIT_AUTHOR_EMAIL: "drimvox@localhost", GIT_COMMITTER_NAME: "Drimvox", GIT_COMMITTER_EMAIL: "drimvox@localhost" };

/** The folder's files as a tree, read through a temporary index. */
async function treeOf(folder: string): Promise<string> {
  const index = join(tmpdir(), `drimvox-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    // A file git cannot take is left out, not the whole snapshot (seen live: a file named nul, made by `> nul` in Git Bash,
    // failed every snapshot of Nexus, so no answer counted as a change: no tester came and nothing could be undone).
    await runGit(folder, ["add", "-A", "--ignore-errors", "--", ".", ...withoutDependencies()], true, env);
    return (await runGit(folder, ["write-tree"], false, env)).stdout.trim();
  } finally {
    rmSync(index, { force: true });
  }
}

/** Saves the folder as it is now; null when it is not the top of a git repository (then there is no undo). */
export async function checkpoint(folder: string, ref: string): Promise<string | null> {
  if (!(await isRepoRoot(folder))) return null;
  const tree = await treeOf(folder);
  const commit = (await runGit(folder, ["commit-tree", tree, "-m", "Drimvox chat checkpoint"], false, DRIMVOX)).stdout.trim();
  await runGit(folder, ["update-ref", ref, commit]);
  return commit;
}

/** What changed in the folder since the snapshot, as a unified diff. */
export async function diffSince(folder: string, commit: string): Promise<string> {
  return (await runGit(folder, ["diff-tree", "-p", "--no-renames", commit, await treeOf(folder)], true)).stdout;
}

/** Whether the folder differs from the snapshot. */
export async function changedSince(folder: string, commit: string): Promise<boolean> {
  const then = (await runGit(folder, ["rev-parse", `${commit}^{tree}`])).stdout.trim();
  return then !== (await treeOf(folder));
}

/** Puts the folder back as the snapshot had it: changed and deleted files come back, files created since go. */
export async function restore(folder: string, commit: string): Promise<void> {
  const now = await treeOf(folder);
  const diff = (await runGit(folder, ["diff-tree", "-r", "--no-renames", "--name-status", commit, now])).stdout;
  const back: string[] = [];
  for (const line of diff.split("\n").filter(Boolean)) {
    const [status, path] = line.split("\t") as [string, string];
    if (status === "A") {
      const file = join(folder, path);
      if (existsSync(file)) unlinkSync(file);
    } else back.push(path);
  }
  if (back.length === 0) return;
  const index = join(tmpdir(), `drimvox-index-${randomUUID()}`);
  try {
    await runGit(folder, ["read-tree", commit], false, { GIT_INDEX_FILE: index });
    await runGit(folder, ["checkout-index", "-f", "--", ...back], false, { GIT_INDEX_FILE: index });
  } finally {
    rmSync(index, { force: true });
  }
}

export async function dropCheckpoint(folder: string, ref: string): Promise<void> {
  await runGit(folder, ["update-ref", "-d", ref], true);
}
