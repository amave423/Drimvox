import type { PendingApproval, TaskEvent, TaskFeedback, TaskView } from "@artel/shared";
import type { ModelMessage } from "ai";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { findModel } from "../providers/catalog";
import type { ProviderRepo } from "../providers/repo";
import { addWorktree, headCommit } from "./git";
import { feedbackMessage } from "./prompt";
import { toTaskView, type ProjectRepo, type TaskRepo, type TaskRow } from "./repo";
import { acceptTask, discardTask, hasChanges, snapshot, taskDiff } from "./review";
import { runAgent, type RunOutcome } from "./run";

export type TaskUpdate = { type: "event"; event: TaskEvent } | { type: "task"; task: TaskView };

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
  idleTimeoutMs: number;
}

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

  async start(projectId: string, input: { task: string; providerId: string; model: string }): Promise<TaskView> {
    const project = this.o.projects.get(projectId);
    if (!project) throw new Error("Unknown project");
    const id = randomUUID();
    const branch = `artel/${id.slice(0, 8)}`;
    const worktree = join(this.o.dataDir, "worktrees", id);
    const base = await headCommit(project.path);
    await addWorktree(project.path, worktree, branch, base);

    const firstLine = input.task.trim().split("\n")[0]!.trim();
    this.o.tasks.create({
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
    });
    this.launch(id, input.task);
    return this.view(id)!;
  }

  /** After a budget or step limit, a Stop or a failure: carry on in the same copy. */
  continue(id: string, note?: string): TaskView {
    const row = this.require(id, ["waiting", "stopped", "failed"]);
    if (row.status_reason === "budget") this.o.tasks.update(id, { budget_usd: row.budget_usd + this.o.budgetUsd() });
    this.launch(id, note || "Continue the task.");
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
    const row = this.require(id, ["review", "done_empty", "stopped", "failed", "waiting"], true);
    const project = this.o.projects.get(row.project_id)!;
    const commit = await acceptTask(project.path, row, message ?? row.commit_message ?? row.title);
    this.setStatus(id, "accepted", null);
    return commit;
  }

  async discard(id: string): Promise<void> {
    const row = this.require(id, ["review", "done_empty", "stopped", "failed", "waiting"], true);
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

  private require(id: string, allowed: TaskRow["status"][], idle = false): TaskRow {
    const row = this.o.tasks.row(id);
    if (!row) throw new Error("Unknown task");
    if (this.live.has(id) || !allowed.includes(row.status) || (idle && this.live.has(id))) {
      throw new TaskBusy(`Task is ${row.status}`);
    }
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

  private async run(id: string, userText: string, live: Live): Promise<void> {
    const row = this.o.tasks.row(id)!;
    const messages: ModelMessage[] = [...this.o.tasks.messages(id), { role: "user", content: userText }];
    this.o.tasks.update(id, { messages: JSON.stringify(messages) });
    this.event(id, "user", { text: userText });
    this.setStatus(id, "running", null);

    const conn = row.provider_id ? this.o.providers.connection(row.provider_id) : null;
    if (!conn) return this.finish(id, "failed", "no_provider");

    let cost = row.cost_usd;
    let input = row.input_tokens;
    let output = row.output_tokens;
    let steps = row.steps;

    const outcome: RunOutcome = await runAgent({
      conn,
      model: row.model,
      price: await findModel(conn, row.model),
      worktree: row.worktree,
      messages,
      spentUsd: row.cost_usd,
      budgetUsd: this.o.tasks.row(id)!.budget_usd,
      signal: live.controller.signal,
      idleTimeoutMs: this.o.idleTimeoutMs,
      onText: (text) => this.event(id, "text", { text }),
      onStep: (step) => {
        if (this.closed) return;
        messages.push(...step.messages);
        cost += step.costUsd;
        input += step.inputTokens;
        output += step.outputTokens;
        steps++;
        this.o.tasks.update(id, { messages: JSON.stringify(messages), cost_usd: cost, input_tokens: input, output_tokens: output, steps });
        this.publishTask(id);
      },
      hooks: {
        onCall: (call) => this.event(id, "tool_call", call),
        onResult: (result) => this.event(id, "tool_result", result),
        askApproval: (command, reason, signal) => this.askApproval(id, live, command, reason, signal),
      },
    });
    if (this.closed) return;

    if (outcome.kind === "stopped") return this.finish(id, "stopped", "user");
    if (outcome.kind === "error") return this.finish(id, "failed", outcome.error.code, outcome.error.detail);
    if (outcome.kind === "budget" || outcome.kind === "steps") return this.finish(id, "waiting", outcome.kind);

    const current = this.o.tasks.row(id)!;
    await snapshot(current);
    const project = this.o.projects.get(current.project_id)!;
    const changed = await hasChanges(project.path, current);
    this.o.tasks.update(id, {
      summary: outcome.summary,
      commit_message: outcome.commitMessage ?? current.commit_message ?? current.title,
    });
    this.finish(id, changed ? "review" : "done_empty", null);
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
