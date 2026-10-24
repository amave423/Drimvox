import type { DiffFile } from "@drimvox/shared";
import {
  changedFiles,
  commitAll,
  conflictingFiles,
  currentBranch,
  diffText,
  dirtyFiles,
  ensureIdentity,
  removeWorktree,
  showFile,
  squashInto,
} from "./git";
import { parseDiff } from "./diff";
import type { TaskRepo, TaskRow } from "./repo";

export const WIP_MESSAGE = "Drimvox: work in progress";

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

const CLOSED = ["accepted", "discarded", "merged", "queued"];

/** The task's changes against where it started; a running task's copy is saved first. */
export async function reviewDiff(row: TaskRow, repo: string | null, running: boolean): Promise<DiffFile[]> {
  if (!repo || CLOSED.includes(row.status)) return [];
  // A goal's copy changes only through the commits of merged subtasks.
  if (!running && row.kind !== "goal") await snapshot(row);
  return taskDiff(repo, row);
}

/** A file as the task's branch has it, for showing pictures in the review. */
export async function reviewFile(row: TaskRow, repo: string | null, running: boolean, path: string): Promise<Buffer | null> {
  if (!repo || CLOSED.includes(row.status)) return null;
  if (!running && row.kind !== "goal") await snapshot(row);
  return showFile(repo, row.branch, path);
}

/** A goal that ends takes its unmerged subtasks and their copies with it. */
export async function closeSubtasks(tasks: TaskRepo, repo: string, goal: TaskRow): Promise<void> {
  if (goal.kind !== "goal") return;
  for (const sub of tasks.children(goal.id)) {
    if (sub.status === "merged") continue;
    await removeWorktree(repo, sub.worktree, sub.branch);
    tasks.update(sub.id, { status: "discarded", status_reason: null });
  }
}
