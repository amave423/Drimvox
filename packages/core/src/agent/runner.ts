import type {
  ModelRef,
  PendingApproval,
  PlannedSubtask,
  Question,
  TaskEvent,
  TaskFeedback,
  TaskPhase,
  TaskStages,
  TaskUpdate,
  TaskView,
} from "@artel/shared";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { imageToolsFor } from "../media/agent-tool";
import type { WebAccess } from "../internet/web";
import type { MediaRepo } from "../media/repo";
import type { ProviderRepo } from "../providers/repo";
import { addWorktree, headCommit, removeWorktree, showFile } from "./git";
import { runPass, startWork, enterPhase, type PassContext } from "./pass";
import { answersMessage, specMessage } from "./phases";
import { feedbackMessage } from "./prompt";
import { toTaskView, type ProjectRepo, type TaskRepo, type TaskRow } from "./repo";
import { acceptTask, discardTask, snapshot, taskDiff } from "./review";
import { Team } from "./team";

interface Live {
  controller: AbortController;
  approval: (PendingApproval & { resolve(allow: boolean): void }) | null;
  done: Promise<void>;
}

/** A request the API answers with 409: the task is not in a state that allows it. */
export class TaskBusy extends Error {}

export interface RunnerOptions {
  tasks: TaskRepo;
  projects: ProjectRepo;
  providers: ProviderRepo;
  dataDir: string;
  budgetUsd(): number;
  strongModel(): { providerId: string; model: string } | null;
  /** The model agents draw pictures with; null leaves them without the picture tool. */
  imageModel(): { providerId: string; model: string } | null;
  media: MediaRepo;
  web: WebAccess;
  /** Shared skills; project skills are read from each task's copy. */
  skillsDir: string;
  idleTimeoutMs: number;
}

/** Waiting states that need an answer from the user rather than "Continue". */
const ANSWER_REASONS = new Set(["questions", "spec_review", "plan_review", "approval"]);

/** Owns every running agent: starts them, relays their events, answers approvals, stops them. */
export class AgentRunner {
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Map<string, Set<(u: TaskUpdate) => void>>();
  private closed = false;
  private readonly team: Team;

  constructor(private readonly o: RunnerOptions) {
    this.team = new Team({
      tasks: o.tasks,
      projects: o.projects,
      dataDir: o.dataDir,
      closed: () => this.closed,
      isRunning: (id) => this.live.has(id),
      launch: (id, message) => this.launch(id, message),
      event: (id, kind, data) => this.event(id, kind, data),
      finish: (id, status, reason, detail) => this.finish(id, status, reason, detail),
      setStatus: (id, status, reason) => this.setStatus(id, status, reason),
    });
  }

  view(id: string): TaskView | null {
    const row = this.o.tasks.row(id);
    if (!row) return null;
    const approval = this.live.get(id)?.approval;
    const pending = approval ? { id: approval.id, command: approval.command, reason: approval.reason } : null;
    return toTaskView(row, pending, row.kind === "goal" ? this.o.tasks.children(id) : []);
  }

  async start(
    projectId: string,
    input: { task: string; providerId: string; model: string; stages: TaskStages; team?: ModelRef },
  ): Promise<TaskView> {
    const project = this.o.projects.get(projectId);
    if (!project) throw new Error("Unknown project");
    const id = randomUUID();
    const branch = `artel/${id.slice(0, 8)}`;
    const worktree = join(this.o.dataDir, "worktrees", id);
    const base = await headCommit(project.path);
    await addWorktree(project.path, worktree, branch, base);

    // A team always plans first: the plan is what splits the goal into subtasks.
    const stages = input.team ? { ...input.stages, spec: true } : input.stages;
    const firstLine = input.task.trim().split("\n")[0]!.trim();
    this.o.tasks.create(
      {
        id,
        project_id: projectId,
        title: firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine,
        task: input.task,
        provider_id: input.providerId,
        model: input.model,
        status: "running",
        branch,
        worktree,
        base_commit: base,
        budget_usd: this.o.budgetUsd(),
      },
      stages,
      input.team ? { kind: "goal", team: JSON.stringify(input.team) } : {},
    );
    const first: TaskPhase = stages.interview ? "interview" : stages.spec ? "spec" : "code";
    enterPhase(this.context(id, new AbortController()), id, first);
    this.launch(id, input.task);
    return this.view(id)!;
  }

  answerQuestions(id: string, answers: { id: string; answer: string }[], skip: boolean): TaskView {
    const row = this.requireWaiting(id, "questions");
    const questions = JSON.parse(row.questions) as Question[];
    this.event(id, "answers", { answers: skip ? [] : answers, skipped: skip });
    this.o.tasks.update(id, { questions: "[]" });
    const stages = JSON.parse(row.stages) as TaskStages;
    enterPhase(this.context(id, new AbortController()), id, stages.spec ? "spec" : "code");
    this.launch(id, answersMessage(questions, answers, skip));
    return this.view(id)!;
  }

  approveSpec(id: string, spec: string, checks: string[]): TaskView {
    const row = this.requireWaiting(id, "spec_review");
    const edited = spec !== row.spec || JSON.stringify(checks) !== row.checks;
    this.o.tasks.update(id, { spec, checks: JSON.stringify(checks) });
    if (edited) this.event(id, "spec", { spec, checks, plan: JSON.parse(row.plan), edited: true });
    const stages = JSON.parse(row.stages) as TaskStages;
    const message = startWork(this.context(id, new AbortController()), id, stages, specMessage(spec, checks, edited), checks);
    this.launch(id, message);
    return this.view(id)!;
  }

  reviseSpec(id: string, note: string): TaskView {
    const row = this.require(id, ["waiting"]);
    const plan = row.status_reason === "plan_review";
    if (!plan && row.status_reason !== "spec_review") throw new TaskBusy(`Task waits for ${row.status_reason}`);
    const what = plan ? "plan" : "spec";
    this.launch(id, `The user asks to rewrite the ${what}: ${note}\n\nCall propose_${what} again with the new version.`);
    return this.view(id)!;
  }

  /** The user's OK on a goal's plan, possibly edited: the team starts on the subtasks. */
  approvePlan(id: string, p: { spec: string; checks: string[]; subtasks: PlannedSubtask[] }): TaskView {
    const row = this.requireWaiting(id, "plan_review");
    const ids = new Set(p.subtasks.map((s) => s.id));
    if (ids.size !== p.subtasks.length) throw new TaskBusy("Subtask ids repeat");
    // Dependencies on removed subtasks would never be met.
    const subtasks = p.subtasks.map((s) => ({ ...s, dependsOn: [...new Set(s.dependsOn)].filter((d) => ids.has(d) && d !== s.id) }));
    const edited = p.spec !== row.spec || JSON.stringify(p.checks) !== row.checks || JSON.stringify(subtasks) !== row.planned;
    this.o.tasks.update(id, {
      spec: p.spec,
      checks: JSON.stringify(p.checks),
      plan: JSON.stringify(subtasks.map((s) => s.title)),
      planned: JSON.stringify(subtasks),
    });
    if (edited) this.event(id, "plan", { spec: p.spec, checks: p.checks, subtasks, edited: true });
    this.team.start(id);
    return this.view(id)!;
  }

  /** After a limit, a Stop, a failure or getting stuck: carry on in the same copy. */
  continue(id: string, note?: string): TaskView {
    const row = this.require(id, ["waiting", "stopped", "failed"]);
    if (row.status === "waiting" && ANSWER_REASONS.has(row.status_reason ?? "")) throw new TaskBusy("Task waits for an answer");
    if (row.kind === "goal" && row.phase === "orchestrate") {
      this.team.resume(id, note, (sub) => {
        try {
          this.continue(sub);
        } catch {
          // A subtask that waits for an answer or already runs needs no push.
        }
      });
      return this.view(id)!;
    }
    if (row.kind === "subtask" && row.status_reason === "conflict") {
      this.team.restart(id);
      return this.view(id)!;
    }
    if (row.status_reason === "budget") this.o.tasks.update(id, { budget_usd: row.budget_usd + this.o.budgetUsd() });
    if (row.status_reason === "stuck") this.o.tasks.update(id, { attempts: 0 });
    this.launch(id, note || (row.status_reason === "stuck" ? "The checks still fail. Try a different approach." : "Continue the task."));
    return this.view(id)!;
  }

  /** Takes a subtask that is stuck or not started out of its goal; the rest of the team goes on. */
  dropSubtask(id: string): TaskView {
    const row = this.require(id, ["queued", "waiting", "stopped", "failed"]);
    if (row.kind !== "subtask") throw new TaskBusy("Only a subtask can be dropped");
    this.team.drop(id);
    return this.view(id)!;
  }

  feedback(id: string, f: TaskFeedback): TaskView {
    const row = this.require(id, ["review", "done_empty"]);
    // After an answer, "feedback" is simply the next question.
    this.launch(id, row.status_reason === "answered" && f.note ? f.note : feedbackMessage(f.note, f.comments));
    return this.view(id)!;
  }

  stop(id: string): boolean {
    const row = this.o.tasks.row(id);
    if (row?.kind === "goal" && row.phase === "orchestrate" && (row.status === "running" || row.status === "waiting")) {
      // The goal stops first, so its stopped subtasks do not read as stuck.
      this.finish(id, "stopped", "user");
      for (const sub of this.o.tasks.children(id)) this.stop(sub.id);
    }
    const live = this.live.get(id);
    live?.controller.abort();
    return !!live;
  }

  answer(id: string, approvalId: string, allow: boolean): boolean {
    const approval = this.live.get(id)?.approval;
    if (!approval || approval.id !== approvalId) return false;
    approval.resolve(allow);
    return true;
  }

  async diff(id: string) {
    const row = this.o.tasks.row(id);
    if (!row) return null;
    const project = this.o.projects.get(row.project_id);
    if (!project || ["accepted", "discarded", "merged", "queued"].includes(row.status)) return [];
    // A goal's copy changes only through the commits of merged subtasks.
    if (!this.live.has(id) && row.kind !== "goal") await snapshot(row);
    return taskDiff(project.path, row);
  }

  /** A file as the task's branch has it, for showing pictures in the review. */
  async file(id: string, path: string): Promise<Buffer | null> {
    const row = this.o.tasks.row(id);
    if (!row || ["accepted", "discarded", "merged", "queued"].includes(row.status)) return null;
    if (!this.live.has(id) && row.kind !== "goal") await snapshot(row);
    const project = this.o.projects.get(row.project_id);
    return project ? showFile(project.path, row.branch, path) : null;
  }

  async accept(id: string, message?: string): Promise<string | null> {
    const row = this.require(id, ["review", "done_empty", "stopped", "failed", "waiting"]);
    const project = this.o.projects.get(row.project_id)!;
    const commit = await acceptTask(project.path, row, message ?? row.commit_message ?? row.title);
    await this.closeSubtasks(row);
    this.setStatus(id, "accepted", null);
    return commit;
  }

  async discard(id: string): Promise<void> {
    const row = this.require(id, ["review", "done_empty", "stopped", "failed", "waiting"]);
    const project = this.o.projects.get(row.project_id)!;
    await discardTask(project.path, row);
    await this.closeSubtasks(row);
    this.setStatus(id, "discarded", null);
  }

  /** A goal that ends takes its unmerged subtasks and their copies with it. */
  private async closeSubtasks(goal: TaskRow): Promise<void> {
    if (goal.kind !== "goal") return;
    const project = this.o.projects.get(goal.project_id)!;
    for (const sub of this.o.tasks.children(goal.id)) {
      if (sub.status === "merged") continue;
      await removeWorktree(project.path, sub.worktree, sub.branch);
      this.o.tasks.update(sub.id, { status: "discarded", status_reason: null });
    }
  }

  subscribe(id: string, listener: (u: TaskUpdate) => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    return () => set.delete(listener);
  }

  isRunning(id: string): boolean {
    return this.live.has(id);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const live of this.live.values()) live.controller.abort();
    await Promise.all([...this.live.values()].map((l) => l.done.catch(() => {})));
  }

  private require(id: string, allowed: TaskRow["status"][]): TaskRow {
    const row = this.o.tasks.row(id);
    if (!row) throw new Error("Unknown task");
    if (this.live.has(id) || !allowed.includes(row.status)) throw new TaskBusy(`Task is ${row.status}`);
    if (row.kind === "goal" && this.o.tasks.children(id).some((s) => this.live.has(s.id))) throw new TaskBusy("Subtasks are running");
    return row;
  }

  private requireWaiting(id: string, reason: string): TaskRow {
    const row = this.require(id, ["waiting"]);
    if (row.status_reason !== reason) throw new TaskBusy(`Task waits for ${row.status_reason}`);
    return row;
  }

  private launch(id: string, userText: string): void {
    const controller = new AbortController();
    const live: Live = { controller, approval: null, done: Promise.resolve() };
    this.live.set(id, live);
    live.done = this.run(id, userText, live)
      .catch((err) => {
        if (!this.closed) this.finish(id, "failed", "unknown", String(err));
      })
      .finally(() => {
        this.live.delete(id);
        if (this.closed) return;
        this.publishTask(id);
        const parent = this.o.tasks.row(id)?.parent_id;
        if (parent) void this.team.drive(parent);
      });
  }

  /** Passes follow each other until the task waits for the user, finishes or is stopped. */
  private async run(id: string, userText: string, live: Live): Promise<void> {
    const ctx = this.context(id, live.controller, live);
    let next: string | null = userText;
    while (next !== null && !this.closed && !live.controller.signal.aborted) {
      next = await runPass(ctx, id, next);
    }
  }

  private context(id: string, controller: AbortController, live?: Live): PassContext {
    return {
      tasks: this.o.tasks,
      projects: this.o.projects,
      providers: this.o.providers,
      idleTimeoutMs: this.o.idleTimeoutMs,
      strongModel: this.o.strongModel,
      signal: controller.signal,
      closed: () => this.closed,
      event: (kind, data) => this.event(id, kind, data),
      finish: (status, reason, detail) => this.finish(id, status, reason, detail),
      setStatus: (status, reason) => this.setStatus(id, status, reason),
      publish: () => this.publishTask(id),
      askApproval: (command, reason, signal) => (live ? this.askApproval(id, live, command, reason, signal) : Promise.resolve(false)),
      startTeam: () => this.team.start(id),
      web: this.o.web,
      skillsDir: this.o.skillsDir,
      imageTools: (row, hooks, onSpend, budgetLeft) =>
        imageToolsFor(this.o.imageModel(), this.o.providers, { worktree: row.worktree, taskId: id, media: this.o.media, hooks, budgetLeft, onSpend }),
    };
  }

  private askApproval(id: string, live: Live, command: string, reason: string, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const approvalId = randomUUID();
      const settle = (allow: boolean) => {
        live.approval = null;
        signal?.removeEventListener("abort", onAbort);
        this.event(id, "approval", { id: approvalId, command, reason, allowed: allow });
        this.setStatus(id, "running", null);
        resolve(allow);
      };
      const onAbort = () => settle(false);
      live.approval = { id: approvalId, command, reason, resolve: settle };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.event(id, "approval", { id: approvalId, command, reason, allowed: null });
      this.setStatus(id, "waiting", "approval");
    });
  }

  private finish(id: string, status: TaskRow["status"], reason: string | null, detail?: string): void {
    this.event(id, "status", { status, reason, detail: detail ?? null });
    this.setStatus(id, status, reason);
  }

  private setStatus(id: string, status: TaskRow["status"], reason: string | null): void {
    if (this.closed) return;
    this.o.tasks.update(id, { status, status_reason: reason });
    this.publishTask(id);
    // A subtask's progress is the goal's business: the goal decides what happens next.
    const parent = this.o.tasks.row(id)?.parent_id;
    if (parent) void this.team.drive(parent);
  }

  private event(id: string, kind: TaskEvent["kind"], data: unknown): void {
    if (this.closed) return;
    const event = this.o.tasks.addEvent(id, kind, data);
    for (const listener of this.listeners.get(id) ?? []) listener({ type: "event", event });
  }

  private publishTask(id: string): void {
    const task = this.view(id);
    if (!task) return;
    for (const listener of this.listeners.get(id) ?? []) listener({ type: "task", task });
    if (task.parentId) this.publishTask(task.parentId);
  }
}
