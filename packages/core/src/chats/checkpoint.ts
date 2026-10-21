import { randomUUID } from "node:crypto";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffFile } from "@artel/shared";
import { parseDiff } from "../agent/diff";
import { isRepoRoot, runGit, withoutDependencies } from "../agent/git";

/**
 * Snapshots of a chat's folder before each answer, so one button undoes what the model did (docs/specs/chat-folder.md).
 * A snapshot is a commit built in a temporary index and kept under refs/artel/chat/…: the user's branches, history,
 * index and files stay as they are. Ignored files and dependency folders are not part of it and are never touched.
 */
const ARTEL = { GIT_AUTHOR_NAME: "Drimvox", GIT_AUTHOR_EMAIL: "artel@localhost", GIT_COMMITTER_NAME: "Drimvox", GIT_COMMITTER_EMAIL: "artel@localhost" };

/** The folder's files as a tree, read through a temporary index. */
async function treeOf(folder: string): Promise<string> {
  const index = join(tmpdir(), `artel-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await runGit(folder, ["add", "-A", "--", ".", ...withoutDependencies()], false, env);
    return (await runGit(folder, ["write-tree"], false, env)).stdout.trim();
  } finally {
    rmSync(index, { force: true });
  }
}

/** Saves the folder as it is now; null when it is not the top of a git repository (then there is no undo). */
export async function checkpoint(folder: string, ref: string): Promise<string | null> {
  if (!(await isRepoRoot(folder))) return null;
  const tree = await treeOf(folder);
  const commit = (await runGit(folder, ["commit-tree", tree, "-m", "Drimvox chat checkpoint"], false, ARTEL)).stdout.trim();
  await runGit(folder, ["update-ref", ref, commit]);
  return commit;
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
  const index = join(tmpdir(), `artel-index-${randomUUID()}`);
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

/** What changed in the folder since the snapshot, line by line, as the review shows it. */
export async function diffSince(folder: string, commit: string): Promise<DiffFile[]> {
  const now = await treeOf(folder);
  return parseDiff((await runGit(folder, ["diff", "--no-color", "--no-ext-diff", "--no-renames", commit, now])).stdout);
}

/** What changed in the folder since the snapshot, file by file. */
export async function changesSince(folder: string, commit: string): Promise<{ path: string; status: "added" | "modified" | "deleted" }[]> {
  const now = await treeOf(folder);
  const diff = (await runGit(folder, ["diff-tree", "-r", "--no-renames", "--name-status", commit, now])).stdout;
  return diff
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t") as [string, string];
      return { path, status: status === "A" ? "added" : status === "D" ? "deleted" : "modified" } as const;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
