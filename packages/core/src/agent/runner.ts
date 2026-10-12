import type {
  PendingApproval,
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
import type { ProviderRepo } from "../providers/repo";
import { addWorktree, headCommit } from "./git";
import { runPass, startWork, enterPhase, type PassContext } from "./pass";
import { answersMessage, specMessage } from "./phases";
import { feedbackMessage } from "./prompt";
import { toTaskView, type ProjectRepo, type TaskRepo, type TaskRow } from "./repo";
import { acceptTask, discardTask, snapshot, taskDiff } from "./review";

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
  idleTimeoutMs: number;
}

/** Waiting states that need an answer from the user rather than "Continue". */
const ANSWER_REASONS = new Set(["questions", "spec_review", "approval"]);

/** Owns every running agent: starts them, relays their events, answers approvals, stops them. */
export class AgentRunner {
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Map<string, Set<(u: TaskUpdate) => void>>();
  private closed = false;

  constructor(private readonly o: RunnerOptions) {}

  view(id: string): TaskView | null {
    const row = this.o.tasks.row(id);
    if (!row) return null;
    const approval = this.live.get(id)?.approval;
    return toTaskView(row, approval ? { id: approval.id, command: approval.command, reason: approval.reason } : null);
  }

  async start(projectId: string, input: { task: string; providerId: string; model: string; stages: TaskStages }): Promise<TaskView> {
    const project = this.o.projects.get(projectId);
    if (!project) throw new Error("Unknown project");
    const id = randomUUID();
    const branch = `artel/${id.slice(0, 8)}`;
    const worktree = join(this.o.dataDir, "worktrees", id);
    const base = await headCommit(project.path);
    await addWorktree(project.path, worktree, branch, base);

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
      input.stages,
    );
    const first: TaskPhase = input.stages.interview ? "interview" : input.stages.spec ? "spec" : "code";
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
    this.requireWaiting(id, "spec_review");
    this.launch(id, `The user asks to rewrite the spec: ${note}\n\nCall propose_spec again with the new version.`);
    return this.view(id)!;
  }

  /** After a limit, a Stop, a failure or getting stuck: carry on in the same copy. */
  continue(id: string, note?: string): TaskView {
    const row = this.require(id, ["waiting", "stopped", "failed"]);
    if (row.status === "waiting" && ANSWER_REASONS.has(row.status_reason ?? "")) throw new TaskBusy("Task waits for an answer");
    if (row.status_reason === "budget") this.o.tasks.update(id, { budget_usd: row.budget_usd + this.o.budgetUsd() });
    if (row.status_reason === "stuck") this.o.tasks.update(id, { attempts: 0 });
    this.launch(id, note || (row.status_reason === "stuck" ? "The checks still fail. Try a different approach." : "Continue the task."));
    return this.view(id)!;
  }

  feedback(id: string, f: TaskFeedback): TaskView {
    this.require(id, ["review", "done_empty"]);
    this.launch(id, feedbackMessage(f.note, f.comments));
    return this.view(id)!;
  }

  stop(id: string): boolean {
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
    if (!project || row.status === "accepted" || row.status === "discarded") return [];
    if (!this.live.has(id)) await snapshot(row);
    return taskDiff(project.path, row);
  }

  async accept(id: string, message?: string): Promise<string | null> {
    const row = this.require(id, ["review", "done_empty", "stopped", "failed", "waiting"]);
    const project = this.o.projects.get(row.project_id)!;
    const commit = await acceptTask(project.path, row, message ?? row.commit_message ?? row.title);
    this.setStatus(id, "accepted", null);
    return commit;
  }

  async discard(id: string): Promise<void> {
    const row = this.require(id, ["review", "done_empty", "stopped", "failed", "waiting"]);
    const project = this.o.projects.get(row.project_id)!;
    await discardTask(project.path, row);
    this.setStatus(id, "discarded", null);
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
        if (!this.closed) this.publishTask(id);
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
  }
}
