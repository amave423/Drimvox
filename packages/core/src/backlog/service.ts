import { BATCH_POINTS, pointsOf, type BacklogItem, type TaskView, type WorkChanges, type WorkStart } from "@artel/shared";
import type { ProjectRepo } from "../agent/repo";
import { runGit } from "../agent/git";
import type { AgentRunner } from "../agent/runner";
import { changesSince, checkpoint, dropCheckpoint, restore } from "../chats/checkpoint";
import type { ChatRepo } from "../chats/repo";
import { workMessage } from "../work/prompt";
import type { BacklogRepo } from "./repo";

/** Refusals the API turns into 409 with a code the UI explains. */
export class BacklogRefused extends Error {
  constructor(readonly code: "too_many_points" | "not_open" | "busy" | "nothing_picked" | "not_in_review" | "no_identity" | "not_repo") {
    super(code);
  }
}

const NO_STAGES = { interview: false, spec: false, approveSpec: false, testsFirst: false };
const ref = (itemId: string) => `refs/artel/item/${itemId}`;

/**
 * The project's work as a list (docs/specs/backlog-loop.md): a plan's interview fills it; the user picks a batch of at
 * most BATCH_POINTS; each task is a conversation in the project's folder (docs/specs/project-work.md), reviewed and
 * accepted by the user before "Next" starts another.
 */
export class BacklogService {
  constructor(
    private readonly backlog: BacklogRepo,
    private readonly runner: AgentRunner,
    private readonly projects: ProjectRepo,
    private readonly chats: ChatRepo,
  ) {}

  /** The interview that ends in the task list. */
  plan(projectId: string, input: { task: string; providerId: string; model: string }): Promise<TaskView> {
    return this.runner.start(projectId, { ...input, stages: { ...NO_STAGES, interview: true }, kind: "plan" });
  }

  /** Starts a batch: the tasks in the order given, the first one at once. */
  async run(projectId: string, ids: string[], providerId: string, model: string): Promise<WorkStart> {
    const items = ids.map((id) => this.backlog.get(id));
    if (items.some((i) => !i || i.projectId !== projectId || i.status !== "open")) throw new BacklogRefused("not_open");
    if (pointsOf(items as BacklogItem[]) > BATCH_POINTS) throw new BacklogRefused("too_many_points");
    if (this.backlog.list(projectId).some((i) => i.status === "active" || i.status === "review" || i.status === "picked")) throw new BacklogRefused("busy");
    this.backlog.reorder(projectId, ids);
    for (const id of ids) this.backlog.update(id, { status: "picked" });
    return this.start(items[0]!, providerId, model);
  }

  /** The next task of the batch, with the model the last one used. */
  async next(projectId: string): Promise<WorkStart> {
    const list = this.backlog.list(projectId);
    if (list.some((i) => i.status === "active" || i.status === "review")) throw new BacklogRefused("busy");
    const item = list.find((i) => i.status === "picked");
    if (!item) throw new BacklogRefused("nothing_picked");
    const last = list
      .filter((i) => i.chatId)
      .map((i) => this.chats.get(i.chatId!))
      .filter((c) => c?.providerId && c.model)
      .sort((a, b) => b!.updatedAt - a!.updatedAt)[0];
    if (!last) throw new BacklogRefused("nothing_picked");
    return this.start(item, last.providerId!, last.model!);
  }

  /** A conversation in the project's folder, and the point to roll the task back to. */
  private async start(item: BacklogItem, providerId: string, model: string): Promise<WorkStart> {
    const project = this.projects.get(item.projectId);
    if (!project) throw new BacklogRefused("not_open");
    const snapshot = await checkpoint(project.path, ref(item.id));
    if (!snapshot) throw new BacklogRefused("not_repo");
    const chat = this.chats.create(providerId, model, "text", { folder: project.path, projectId: project.id, itemId: item.id, title: item.title });
    this.backlog.update(item.id, { status: "active", chatId: chat.id, checkpoint: snapshot });
    return { itemId: item.id, chatId: chat.id, message: workMessage(item, this.backlog.plan(item.projectId)) };
  }

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
    return { files: await changesSince(folder, snapshot) };
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
