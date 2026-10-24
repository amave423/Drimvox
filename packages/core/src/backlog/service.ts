import type { WorkChanges } from "@drimvox/shared";
import type { ProjectRepo } from "../agent/repo";
import { runGit } from "../agent/git";
import { changesSince, diffSince, dropCheckpoint, restore } from "../chats/checkpoint";
import type { ChatRepo } from "../chats/repo";
import type { BacklogRepo } from "./repo";

/** Refusals the API turns into 409 with a code the UI explains. */
export class BacklogRefused extends Error {
  constructor(readonly code: "too_many_points" | "not_open" | "busy" | "nothing_picked" | "not_in_review" | "no_identity" | "not_repo") {
    super(code);
  }
}

const ref = (itemId: string) => `refs/drimvox/item/${itemId}`;

/**
 * The old task list (docs/specs/backlog-loop.md), replaced by one long run (docs/specs/project-work.md): tasks started
 * before still live in their conversations, and are accepted as one commit or rolled back.
 */
export class BacklogService {
  constructor(
    private readonly backlog: BacklogRepo,
    private readonly projects: ProjectRepo,
    private readonly chats: ChatRepo,
  ) {}

  /** The user wrote in a task's conversation: it is being worked on again. */
  working(chatId: string): void {
    const item = this.backlog.byChat(chatId);
    if (item && (item.status === "review" || item.status === "active")) this.backlog.update(item.id, { status: "active" });
  }

  /** The agent answered in a task's conversation: the task waits for the user's review. */
  answered(chatId: string): void {
    const item = this.backlog.byChat(chatId);
    if (item?.status === "active") this.backlog.update(item.id, { status: "review" });
  }

  /** What the task changed in the folder since it started. */
  async changes(itemId: string): Promise<WorkChanges> {
    const { folder, snapshot } = this.workOf(itemId);
    return { files: await changesSince(folder, snapshot), diff: await diffSince(folder, snapshot) };
  }

  /** The task's changes become one commit on the project's current branch; the task is done. */
  async accept(itemId: string, message?: string): Promise<{ commit: string | null }> {
    const item = this.backlog.get(itemId)!;
    if (item?.status !== "review" && item?.status !== "active") throw new BacklogRefused("not_in_review");
    const { folder, snapshot } = this.workOf(itemId);
    const files = await changesSince(folder, snapshot);
    let commit: string | null = null;
    if (files.length > 0) {
      // Only what the task changed: anything the user had left uncommitted before it stays as it was.
      await runGit(folder, ["add", "-A", "--", ...files.map((f) => f.path)]);
      const done = await runGit(folder, ["commit", "-m", (message ?? item.title).trim() || item.title, "--", ...files.map((f) => f.path)], true);
      if (done.code !== 0) {
        await runGit(folder, ["reset", "-q", "--", ...files.map((f) => f.path)], true);
        if (/user\.email|user\.name|identity/i.test(done.stderr)) throw new BacklogRefused("no_identity");
        throw new Error(done.stderr.trim() || "git commit failed");
      }
      commit = (await runGit(folder, ["rev-parse", "--short", "HEAD"])).stdout.trim();
    }
    await dropCheckpoint(folder, ref(itemId)).catch(() => {});
    this.backlog.update(itemId, { status: "done", checkpoint: null });
    return { commit };
  }

  /** Puts the folder back as it was before the task; the task goes back to the list. */
  async undo(itemId: string): Promise<void> {
    const { folder, snapshot } = this.workOf(itemId);
    await restore(folder, snapshot);
    await dropCheckpoint(folder, ref(itemId)).catch(() => {});
    this.backlog.update(itemId, { status: "open", chatId: null, checkpoint: null });
  }

  private workOf(itemId: string): { folder: string; snapshot: string } {
    const item = this.backlog.get(itemId);
    const project = item ? this.projects.get(item.projectId) : null;
    const snapshot = this.backlog.checkpoint(itemId);
    if (!item || !project || !snapshot) throw new BacklogRefused("not_in_review");
    return { folder: project.path, snapshot };
  }

  /** An old-style task of the list was accepted (done) or discarded (back in the list, to pick again). */
  closed(taskId: string, accepted: boolean): void {
    const item = this.backlog.byTask(taskId);
    if (!item) return;
    this.backlog.update(item.id, accepted ? { status: "done" } : { status: "open", taskId: null });
  }
}
