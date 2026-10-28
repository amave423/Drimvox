import type { ActivityEntry, ProjectModels, ProjectWorkView, TaskView } from "@drimvox/shared";
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
  constructor(readonly code: "not_repo" | "no_plan" | "busy" | "not_started" | "no_provider" | "no_site") {
    super(code);
  }
}

const siteKey = (projectId: string) => `site:${projectId}`;

const INTERVIEW = { interview: true, spec: false, approveSpec: false, testsFirst: false };

/**
 * A project's work (docs/specs/project-work.md): the interview and the plan are a task of the project; "Go" starts one
 * long run in the project's conversation. Runs live here, by project.
 */
export class ProjectWork {
  private readonly runs = new Map<string, WorkRun>();
  /** The finished project Drimvox started for the user, by project: its background process. */
  private readonly sites = new Map<string, number>();

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
      // Seen: a plan that failed left its project "working" in the sidebar for good.
      planStalled: row?.status === "planning" && !!row.planTaskId && ["failed", "stopped"].includes(this.o.runner.view(row.planTaskId)?.status ?? ""),
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
      // A run still going counts its current stretch too.
      spentUsd: spending.spentUsd + (live?.progress().inFlightUsd ?? 0),
      workedMs: live ? live.progress().workedMs : (row?.workedMs ?? 0),
      actions: spending.actions,
      waitingApproval: !!chatId && !!live && this.o.approvals.open(chatId).length > 0,
      escalated: row?.escalated ?? false,
      startedAt: row?.startedAt ?? null,
      report: row?.report ?? null,
      site: row?.site ? { url: row.site.url, running: this.siteRunning(projectId) } : null,
    };
  }

  /** Starts what the agent made, as it said to (finish_work's start); it runs until stopped or Drimvox quits. */
  startSite(projectId: string): ProjectWorkView {
    const row = this.o.repo.get(projectId);
    const project = this.o.projects.get(projectId);
    if (!row?.site || !project) throw new WorkRefused("no_site");
    if (this.runs.has(projectId)) throw new WorkRefused("busy");
    this.stopSite(projectId);
    const p = this.o.run.visualKit.background.start(siteKey(projectId), row.site.command, project.path);
    this.sites.set(projectId, p.id);
    return this.view(projectId);
  }

  stopSite(projectId: string): ProjectWorkView {
    this.o.run.visualKit.background.stopAll(siteKey(projectId));
    this.sites.delete(projectId);
    return this.view(projectId);
  }

  private siteRunning(projectId: string): boolean {
    const id = this.sites.get(projectId);
    return id !== undefined && this.o.run.visualKit.background.get(siteKey(projectId), id)?.exitCode === undefined;
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
    this.o.repo.update(projectId, { chatId: chat.id, ...limits, startedAt: Date.now(), workedMs: 0, escalated: false, questions: [], report: null });
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
    for (const id of [...this.sites.keys()]) this.stopSite(id);
    for (const run of this.runs.values()) run.controller.abort();
    await Promise.all([...this.runs.values()].map((r) => r.done.catch(() => {})));
  }

  private launch(projectId: string, chatId: string, folder: string, content: string): void {
    const row = this.o.repo.get(projectId)!;
    const work = row.models?.work;
    const conn = work ? this.o.run.providers.connection(work.providerId) : null;
    if (!work || !conn) throw new WorkRefused("no_provider");
    // The agent works on the project again: the started result frees its port.
    this.stopSite(projectId);
    const ended = (id: string) => {
      if (this.runs.get(id) !== run) return;
      this.runs.delete(id);
      // Done with a result to open: Drimvox starts it (the agent's own processes are stopped by now).
      const now = this.o.repo.get(id);
      if (now?.status === "done" && now.site) {
        try {
          this.startSite(id);
        } catch {
          // Shown as not running; the user can start it.
        }
      }
    };
    const run = new WorkRun({ ...this.o.run, ended }, projectId, chatId, folder);
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
    const activity: ActivityEntry[] = [];
    let written = 0;
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
        if (e.type === "text") written += e.text.length;
        if (e.type === "tool") activity.push({ name: e.name, input: e.input, at: written });
      },
    });
    const answer = this.o.chats.get(run.chatId)?.messages.at(-1);
    this.o.repo.update(run.projectId, run.controller.signal.aborted ? { status: "stopped", reason: "user" } : answer?.status === "error" ? { status: "paused", reason: "error", detail: answer.error?.code ?? null } : { status: "done", reason: null });
  }
}
