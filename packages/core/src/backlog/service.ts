import { BATCH_POINTS, pointsOf, type BacklogItem, type ProjectPlan, type TaskView } from "@artel/shared";
import type { AgentRunner } from "../agent/runner";
import type { TaskRepo } from "../agent/repo";
import type { BacklogRepo } from "./repo";

/** Refusals the API turns into 409 with a code the UI explains. */
export class BacklogRefused extends Error {
  constructor(readonly code: "too_many_points" | "not_open" | "busy" | "nothing_picked") {
    super(code);
  }
}

const NO_STAGES = { interview: false, spec: false, approveSpec: false, testsFirst: false };

/**
 * The project's work as a list (docs/specs/backlog-loop.md): a plan's interview fills it; the user picks a batch of at
 * most BATCH_POINTS; its tasks run one at a time, each reviewed and accepted by the user before "Next" starts another.
 */
export class BacklogService {
  constructor(
    private readonly backlog: BacklogRepo,
    private readonly tasks: TaskRepo,
    private readonly runner: AgentRunner,
  ) {}

  /** The interview that ends in the task list. */
  plan(projectId: string, input: { task: string; providerId: string; model: string }): Promise<TaskView> {
    return this.runner.start(projectId, { ...input, stages: { ...NO_STAGES, interview: true }, kind: "plan" });
  }

  /** Starts a batch: the tasks in the order given, the first one at once. */
  async run(projectId: string, ids: string[], providerId: string, model: string): Promise<TaskView> {
    const items = ids.map((id) => this.backlog.get(id));
    if (items.some((i) => !i || i.projectId !== projectId || i.status !== "open")) throw new BacklogRefused("not_open");
    if (pointsOf(items as BacklogItem[]) > BATCH_POINTS) throw new BacklogRefused("too_many_points");
    if (this.backlog.list(projectId).some((i) => i.status === "active" || i.status === "picked")) throw new BacklogRefused("busy");
    this.backlog.reorder(projectId, ids);
    for (const id of ids) this.backlog.update(id, { status: "picked" });
    return this.start(items[0]!, providerId, model);
  }

  /** The next task of the batch, with the model the last one used. */
  async next(projectId: string): Promise<TaskView> {
    const list = this.backlog.list(projectId);
    if (list.some((i) => i.status === "active")) throw new BacklogRefused("busy");
    const item = list.find((i) => i.status === "picked");
    if (!item) throw new BacklogRefused("nothing_picked");
    const last = list.filter((i) => i.taskId).map((i) => this.tasks.row(i.taskId!)).filter((r) => r?.provider_id).sort((a, b) => b!.created_at - a!.created_at)[0];
    if (!last) throw new BacklogRefused("nothing_picked");
    return this.start(item, last.provider_id!, last.model);
  }

  /** A task of the list was accepted (done) or discarded (back in the list, to pick again). */
  closed(taskId: string, accepted: boolean): void {
    const item = this.backlog.byTask(taskId);
    if (!item) return;
    this.backlog.update(item.id, accepted ? { status: "done" } : { status: "open", taskId: null });
  }

  private async start(item: BacklogItem, providerId: string, model: string): Promise<TaskView> {
    const plan = this.backlog.plan(item.projectId);
    const view = await this.runner.start(item.projectId, {
      task: itemTask(item, plan),
      providerId,
      model,
      stages: NO_STAGES,
      kind: "item",
      extra: {
        checks: JSON.stringify(plan?.checks ?? []),
        design: plan?.design ? JSON.stringify(plan.design) : null,
        requirements: JSON.stringify(item.done.map((text, n) => ({ id: `R${n + 1}`, text, verify: "review" }))),
      },
    });
    this.backlog.update(item.id, { status: "active", taskId: view.id });
    return view;
  }
}

/** What the agent is given: the task, its points and what the project is about. */
export function itemTask(item: BacklogItem, plan: ProjectPlan | null): string {
  return [
    item.title,
    "",
    "Готово, когда:",
    ...item.done.map((d) => `- ${d}`),
    ...(plan?.context ? ["", `О проекте: ${plan.context}`] : []),
  ].join("\n");
}
