import type { ProjectModels, ProjectWorkView, TaskView } from "@artel/shared";
import type { ProjectRepo } from "../agent/repo";
import type { AgentRunner } from "../agent/runner";
import { isRepoRoot } from "../agent/git";
import type { BacklogRepo } from "../backlog/repo";
import type { ChatApprovals } from "../chats/approvals";
import { reply } from "../chats/reply";
import type { ChatRepo } from "../chats/repo";
import { isCli } from "../cli/kinds";
import { planMessage, projectRules } from "./prompt";
import type { ProjectWorkRepo } from "./repo";
import { WorkRun, type RunDeps } from "./run";

/** Refusals the API turns into 409 with a code the UI explains. */
export class WorkRefused extends Error {
  constructor(readonly code: "not_repo" | "no_plan" | "busy" | "not_started" | "no_provider") {
    super(code);
  }
}

const INTERVIEW = { interview: true, spec: false, approveSpec: false, testsFirst: false };

/**
 * A project's work (docs/specs/project-work.md): the interview and the plan are a task of the project; "Go" starts one
 * long run in the project's conversation. Runs live here, by project.
 */
export class ProjectWork {
  private readonly runs = new Map<string, WorkRun>();

  constructor(
    private readonly o: {
      repo: ProjectWorkRepo;
      runner: AgentRunner;
      projects: ProjectRepo;
      chats: ChatRepo;
      backlog: BacklogRepo;
      approvals: ChatApprovals;
      run: Omit<RunDeps, "ended">;
      cliDir: string;
    },
  ) {}

  view(projectId: string): ProjectWorkView {
    const row = this.o.repo.get(projectId);
    const chatId = row?.chatId ?? null;
    const spending = chatId && row?.startedAt ? this.o.repo.spending(chatId, row.startedAt) : { spentUsd: 0, actions: 0 };
    const live = this.runs.get(projectId);
    return {
      projectId,
      status: row?.status ?? "idle",
      reason: row?.reason ?? null,
      detail: row?.detail ?? null,
      models: row?.models ?? null,
      planTaskId: row?.planTaskId ?? null,
      plan: this.o.backlog.plan(projectId),
      chatId,
      checklist: row?.checklist ?? [],
      questions: row?.questions ?? [],
      shots: row?.shots ?? [],
      budgetUsd: row?.budgetUsd ?? 1,
      hours: row?.hours ?? 2,
      spentUsd: spending.spentUsd,
      // A run still going counts its current stretch too.
      workedMs: row?.workedMs ?? 0,
      actions: spending.actions,
      waitingApproval: !!chatId && !!live && this.o.approvals.open(chatId).length > 0,
      escalated: row?.escalated ?? false,
      startedAt: row?.startedAt ?? null,
    };
  }

  /** Every project's work: what the window watches for notifications. */
  list(): ProjectWorkView[] {
    return this.o.repo.projectIds().map((id) => this.view(id));
  }

  /** The interview, then the plan: a task of the project, with the interview's model first. */
  async plan(projectId: string, task: string, models: ProjectModels): Promise<TaskView> {
    const project = this.o.projects.get(projectId);
    if (!project || !(await isRepoRoot(project.path))) throw new WorkRefused("not_repo");
    if (this.runs.has(projectId)) throw new WorkRefused("busy");
    const view = await this.o.runner.start(projectId, { task, providerId: models.interview.providerId, model: models.interview.model, stages: INTERVIEW, kind: "plan" });
    this.o.repo.update(projectId, { models, planTaskId: view.id, status: "planning", reason: null, detail: null, escalated: false });
    return view;
  }

  /** The user's corrections to the plan: its model writes it again. */
  revise(projectId: string, note: string): TaskView {
    const row = this.o.repo.get(projectId);
    if (!row?.planTaskId || row.status !== "ready") throw new WorkRefused("no_plan");
    const view = this.o.runner.revisePlan(row.planTaskId, note);
    this.o.repo.update(projectId, { status: "planning" });
    return view;
  }

  /** "Go": the project's conversation (one per project), the plan as its message, and the run. */
  start(projectId: string, limits: { budgetUsd: number; hours: number }): { chatId: string } {
    const row = this.o.repo.get(projectId);
    const project = this.o.projects.get(projectId);
    const plan = this.o.backlog.plan(projectId);
    if (!row || !project || !plan || row.status !== "ready" || !row.models) throw new WorkRefused("no_plan");
    if (this.runs.has(projectId)) throw new WorkRefused("busy");
    if (row.planTaskId) {
      try {
        this.o.runner.closePlan(row.planTaskId);
      } catch {
        // A plan task that no longer waits (a restart): the plan is kept all the same.
      }
    }
    const work = row.models.work;
    const known = row.chatId ? this.o.chats.get(row.chatId) : null;
    const chat = known ?? this.o.chats.create(work.providerId, work.model, "text", { folder: project.path, projectId, itemId: null, title: project.name });
    if (known) this.o.chats.update(chat.id, { providerId: work.providerId, model: work.model });
    this.o.repo.update(projectId, { chatId: chat.id, ...limits, startedAt: Date.now(), workedMs: 0, escalated: false, questions: [] });
    this.launch(projectId, chat.id, project.path, planMessage(plan));
    return { chatId: chat.id };
  }

  /** A message in the project's conversation: the run takes it on the way, or starts again with it. */
  message(projectId: string, content: string): { chatId: string; queued: boolean } {
    const row = this.o.repo.get(projectId);
    const project = this.o.projects.get(projectId);
    if (!row?.chatId || !project || !row.startedAt) throw new WorkRefused("not_started");
    const live = this.runs.get(projectId);
    if (live) {
      this.o.chats.addMessage({ chatId: row.chatId, role: "user", content, status: "done" });
      live.post(content);
      return { chatId: row.chatId, queued: true };
    }
    this.launch(projectId, row.chatId, project.path, content);
    return { chatId: row.chatId, queued: false };
  }

  /** After the budget, the time, getting stuck or Stop: go on in the same conversation. */
  continue(projectId: string): { chatId: string } {
    if (this.runs.has(projectId)) throw new WorkRefused("busy");
    return { chatId: this.message(projectId, "Продолжай.").chatId };
  }

  stop(projectId: string): boolean {
    const live = this.runs.get(projectId);
    live?.controller.abort();
    return !!live;
  }

  update(projectId: string, patch: { budgetUsd?: number; hours?: number; strong?: ProjectModels["strong"] }): ProjectWorkView {
    const row = this.o.repo.get(projectId);
    this.o.repo.update(projectId, {
      ...(patch.budgetUsd !== undefined ? { budgetUsd: patch.budgetUsd } : {}),
      ...(patch.hours !== undefined ? { hours: patch.hours } : {}),
      ...(patch.strong !== undefined && row?.models ? { models: { ...row.models, strong: patch.strong } } : {}),
    });
    return this.view(projectId);
  }

  isRunning(projectId: string): boolean {
    return this.runs.has(projectId);
  }

  async shutdown(): Promise<void> {
    for (const run of this.runs.values()) run.controller.abort();
    await Promise.all([...this.runs.values()].map((r) => r.done.catch(() => {})));
  }

  private launch(projectId: string, chatId: string, folder: string, content: string): void {
    const row = this.o.repo.get(projectId)!;
    const work = row.models?.work;
    const conn = work ? this.o.run.providers.connection(work.providerId) : null;
    if (!work || !conn) throw new WorkRefused("no_provider");
    const run = new WorkRun({ ...this.o.run, ended: (id) => this.runs.get(id) === run && this.runs.delete(id) }, projectId, chatId, folder);
    this.runs.set(projectId, run);
    // Claude Code and Codex work with their own loop: the message goes to them as it is (reply() keeps it).
    if (isCli(conn.preset)) {
      this.o.repo.update(projectId, { status: "running", reason: null, detail: null });
      run.done = this.cliTurn(run, conn, work.model, content).finally(() => this.runs.get(projectId) === run && this.runs.delete(projectId));
      return;
    }
    this.o.chats.addMessage({ chatId, role: "user", content, status: "done" });
    run.start();
  }

  private async cliTurn(run: WorkRun, conn: NonNullable<ReturnType<RunDeps["providers"]["connection"]>>, model: string, content: string): Promise<void> {
    const activity: { name: string; input: string }[] = [];
    await reply({
      chats: this.o.chats,
      chatId: run.chatId,
      conn,
      model,
      content,
      signal: run.controller.signal,
      idleTimeoutMs: this.o.run.idleTimeoutMs,
      web: "off",
      webAccess: this.o.run.web,
      folder: this.o.projects.get(run.projectId)?.path ?? null,
      // The CLI works in the project's folder with the project's rules, as in a terminal.
      work: { system: projectRules(this.o.backlog.plan(run.projectId), false), steps: 0 },
      cliDir: this.o.cliDir,
      activity: () => activity,
      emit: async (e) => {
        if (e.type === "tool") activity.push({ name: e.name, input: e.input });
      },
    });
    const answer = this.o.chats.get(run.chatId)?.messages.at(-1);
    this.o.repo.update(run.projectId, run.controller.signal.aborted ? { status: "stopped", reason: "user" } : answer?.status === "error" ? { status: "paused", reason: "error", detail: answer.error?.code ?? null } : { status: "done", reason: null });
  }
}
