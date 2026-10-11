import type { DiffFile } from "@artel/shared";
import {
  changedFiles,
  commitAll,
  conflictingFiles,
  currentBranch,
  diffText,
  dirtyFiles,
  ensureIdentity,
  removeWorktree,
  squashInto,
} from "./git";
import { parseDiff } from "./diff";
import type { TaskRow } from "./repo";

export const WIP_MESSAGE = "Artel: work in progress";

/** Why work cannot be accepted right now; the API answers 409 with the files involved. */
export class AcceptRefused extends Error {
  constructor(
    readonly code: "dirty" | "conflict" | "detached",
    readonly files: string[] = [],
  ) {
    super(code);
  }
}

/** Saves the copy's current state on the task branch so diffs and merges see it. */
export async function snapshot(task: TaskRow): Promise<void> {
  await commitAll(task.worktree, WIP_MESSAGE);
}

export async function hasChanges(repo: string, task: TaskRow): Promise<boolean> {
  return (await changedFiles(repo, task.base_commit, task.branch)).length > 0;
}

export async function taskDiff(repo: string, task: TaskRow): Promise<DiffFile[]> {
  return parseDiff(await diffText(repo, task.base_commit, task.branch));
}

/**
 * Brings the task onto the project's current branch as one commit by the user. Checks first, so a
 * refusal leaves the user's folder exactly as it was.
 */
export async function acceptTask(repo: string, task: TaskRow, message: string): Promise<string | null> {
  await snapshot(task);
  await ensureIdentity(repo);
  if (!(await currentBranch(repo))) throw new AcceptRefused("detached");

  const touched = new Set(await changedFiles(repo, task.base_commit, task.branch));
  const dirty = (await dirtyFiles(repo)).filter((f) => touched.has(f));
  if (dirty.length) throw new AcceptRefused("dirty", dirty);

  const conflicts = await conflictingFiles(repo, task.branch);
  if (conflicts.length) throw new AcceptRefused("conflict", conflicts);

  const commit = await squashInto(repo, task.branch, message);
  await removeWorktree(repo, task.worktree, task.branch);
  return commit;
}

export async function discardTask(repo: string, task: TaskRow): Promise<void> {
  await removeWorktree(repo, task.worktree, task.branch);
}
