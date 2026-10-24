import type { AcceptanceReport, Milestone, Requirement } from "@drimvox/shared";
import { accepted } from "./acceptance";
import type { Rework } from "./landing";
import type { ModelRef, PlannedSubtask, TaskEvent, TaskStages } from "@drimvox/shared";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { failureReport, runChecks } from "./checks";
import { addWorktree, headCommit, mergeBranch, removeWorktree } from "./git";
import { subtaskBrief } from "./plan";
import type { ProjectRepo, TaskRepo, TaskRow } from "./repo";
import { hasChanges, snapshot } from "./review";

/** Subtasks working at the same time in one goal. */
export const MAX_PARALLEL = 3;
/** Times a subtask is rebuilt on top of the goal after a merge conflict. */
export const MAX_REBUILDS = 2;
/** Fix subtasks a goal may add when its checks go red after a merge. */
export const MAX_FIXES = 2;

const FIX_TITLE = "Fix the checks after a merge";
const ACCEPTANCE_FIX_TITLE = "Finish what the acceptance found missing";
const DESIGN_FIX_TITLE = "Polish the design after the review";
/** Goal states in which subtasks keep going; any other waiting reason needs the user first. */
const DRIVEN = new Set(["running", "waiting:subtask_stuck", "waiting:subtask_waiting"]);

const fixTitle = (rework: Rework) => (rework.design ? DESIGN_FIX_TITLE : ACCEPTANCE_FIX_TITLE);

/** The user's plan, checked: ids must not repeat, and dependencies on removed subtasks are dropped. Null on repeats. */
export function cleanPlan(subtasks: PlannedSubtask[]): PlannedSubtask[] | null {
  const ids = new Set(subtasks.map((s) => s.id));
  if (ids.size !== subtasks.length) return null;
  return subtasks.map((s) => ({ ...s, dependsOn: [...new Set(s.dependsOn)].filter((d) => ids.has(d) && d !== s.id) }));
}

/** What the coordinator needs from the runner. */
export interface TeamHost {
  tasks: TaskRepo;
  projects: ProjectRepo;
  dataDir: string;
  closed(): boolean;
  isRunning(id: string): boolean;
  launch(id: string, message: string): void;
  event(id: string, kind: TaskEvent["kind"], data: unknown): void;
  finish(id: string, status: TaskRow["status"], reason: string | null, detail?: string): void;
  setStatus(id: string, status: TaskRow["status"], reason: string | null): void;
  /** The acceptance agent's verdict on the merged goal: a report, rework for a fix subtask, or null when it stopped. */
  accept(goalId: string): Promise<AcceptanceReport | Rework | null>;
}

/**
 * Runs a goal's subtasks: starts them as their dependencies merge, at most three at a time, merges each
 * finished one into the goal's branch, re-checks the goal, rebuilds conflicting work and adds fixes.
 */
export class Team {
  private readonly chains = new Map<string, Promise<void>>();
  /** Why a subtask is being rebuilt; told to its agent when it starts again. */
  private readonly rebuildNotes = new Map<string, string>();

  constructor(private readonly h: TeamHost) {}

  /** Turns the approved plan into queued subtasks and gets the team going. */
  start(goalId: string): void {
    const goal = this.h.tasks.row(goalId)!;
    const team = JSON.parse(goal.team ?? "null") as ModelRef | null;
    const planned = JSON.parse(goal.planned) as PlannedSubtask[];
    // A subtask without checks of its own is held to the goal's.
    for (const p of planned) this.addSubtask(goal, team, p.id, p.title, p.description, p.dependsOn, p.checks?.length ? p.checks : null, p.stage ?? 1);
    this.h.tasks.update(goalId, { phase: "orchestrate", attempts: 0 });
    this.h.event(goalId, "phase", { phase: "orchestrate" });
    this.h.setStatus(goalId, "running", null);
    void this.drive(goalId);
  }

  /** One coordination round at a time per goal; rounds queue up behind each other. */
  drive(goalId: string): Promise<void> {
    return this.enqueue(goalId, () => this.round(goalId));
  }

  /**
   * "Continue" on a waiting or stopped goal: subtasks that stopped or got stuck carry on, a subtask
   * that kept conflicting starts over on top of the goal, and red checks after a merge get a fix.
   */
  resume(goalId: string, note: string | undefined, continueSubtask: (id: string) => void): void {
    const goal = this.h.tasks.row(goalId)!;
    this.h.setStatus(goalId, "running", null);
    if (goal.status_reason === "integration_red") {
      this.addFix(goal, `The goal's checks fail after the merges so far. Run them, find the cause and fix it.${note ? `\n\nThe user adds: ${note}` : ""}`);
    }
    void this.enqueue(goalId, async () => {
      const project = this.h.projects.get(goal.project_id)!;
      for (const sub of this.h.tasks.children(goalId)) {
        if (this.h.isRunning(sub.id)) continue;
        if (sub.status === "failed" && sub.status_reason === "conflict") {
          await this.requeueFresh(sub, project.path);
        } else if (sub.status === "failed" || sub.status === "stopped" || sub.status === "waiting") {
          continueSubtask(sub.id);
        }
      }
      await this.round(goalId);
    });
  }

  /** "Try again" on a subtask that kept conflicting: it starts over from the goal's current state. */
  restart(subId: string): void {
    const sub = this.h.tasks.row(subId)!;
    const project = this.h.projects.get(sub.project_id)!;
    void this.enqueue(sub.parent_id!, async () => {
      await this.requeueFresh(sub, project.path);
      await this.round(sub.parent_id!);
    });
  }

  /** The user takes a stuck subtask out of the goal; whoever waited for it no longer does. */
  drop(subId: string): void {
    const sub = this.h.tasks.row(subId)!;
    const project = this.h.projects.get(sub.project_id)!;
    const goalId = sub.parent_id!;
    void this.enqueue(goalId, async () => {
      await removeWorktree(project.path, sub.worktree, sub.branch);
      this.h.tasks.update(sub.id, { status: "discarded", status_reason: null });
      for (const other of this.h.tasks.children(goalId)) {
        const deps = JSON.parse(other.depends_on) as string[];
        if (deps.includes(sub.plan_id ?? "")) this.h.tasks.update(other.id, { depends_on: JSON.stringify(deps.filter((d) => d !== sub.plan_id)) });
      }
      this.h.event(goalId, "subtask", { id: sub.plan_id, taskId: sub.id, title: sub.title, action: "dropped" });
      const goal = this.h.tasks.row(goalId)!;
      if (goal.status === "waiting" && goal.status_reason === "subtask_stuck") this.h.setStatus(goalId, "running", null);
      await this.round(goalId);
    });
  }

  private async requeueFresh(sub: TaskRow, repo: string): Promise<void> {
    await removeWorktree(repo, sub.worktree, sub.branch);
    this.h.tasks.update(sub.id, { requeues: 0, status: "queued", status_reason: null });
  }

  private enqueue(goalId: string, work: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(goalId) ?? Promise.resolve())
      .then(work)
      .catch((err) => {
        if (!this.h.closed()) this.h.finish(goalId, "failed", "unknown", String(err));
      });
    this.chains.set(goalId, next);
    return next;
  }

  private addFix(goal: TaskRow, description: string, checks: string[] | null = null, title = FIX_TITLE): void {
    const n = goal.fixes + 1;
    this.h.tasks.update(goal.id, { fixes: n });
    const team = JSON.parse(goal.team ?? "null") as ModelRef | null;
    this.addSubtask(goal, team, `fix-${n}`, title, description, [], checks, goal.milestone);
    this.h.event(goal.id, "subtask", { id: `fix-${n}`, title, action: "fix_added" });
  }

  private addSubtask(
    goal: TaskRow,
    team: ModelRef | null,
    planId: string,
    title: string,
    description: string,
    dependsOn: string[],
    checks: string[] | null,
    stage: number,
  ): void {
    const id = randomUUID();
    const goalStages = JSON.parse(goal.stages) as TaskStages;
    this.h.tasks.create(
      {
        id,
        project_id: goal.project_id,
        title,
        task: description,
        provider_id: team?.providerId ?? goal.provider_id,
        model: team?.model ?? goal.model,
        status: "queued",
        branch: `drimvox/${id.slice(0, 8)}`,
        worktree: join(this.h.dataDir, "worktrees", id),
        base_commit: "",
        budget_usd: goal.budget_usd,
      },
      { interview: false, spec: false, approveSpec: false, testsFirst: goalStages.testsFirst },
      {
        kind: "subtask",
        parent_id: goal.id,
        plan_id: planId,
        depends_on: JSON.stringify(dependsOn),
        checks: checks ? JSON.stringify(checks) : goal.checks,
        spec: goal.spec,
        milestone: stage,
        // Every subtask builds to the same look.
        design: goal.design,
      },
    );
  }

  private async round(goalId: string): Promise<void> {
    if (this.h.closed()) return;
    const goal = this.h.tasks.row(goalId);
    if (!goal || goal.phase !== "orchestrate") return;
    if (!DRIVEN.has(goal.status === "waiting" ? `waiting:${goal.status_reason}` : goal.status)) return;
    const project = this.h.projects.get(goal.project_id)!;

    for (const sub of this.h.tasks.children(goalId)) {
      if (this.h.isRunning(sub.id)) continue;
      if (sub.status === "done_empty") {
        await removeWorktree(project.path, sub.worktree, sub.branch);
        this.merged(goalId, sub);
      } else if (sub.status === "review") {
        const stop = await this.mergeOne(goalId, sub, project.path);
        if (stop) return;
      }
    }

    let subs = this.h.tasks.children(goalId);
    const merged = new Set(subs.filter((s) => s.status === "merged").map((s) => s.plan_id));
    let running = subs.filter((s) => this.h.isRunning(s.id)).length;
    for (const sub of subs) {
      if (running >= MAX_PARALLEL) break;
      // A goal in stages runs one stage at a time.
      if (sub.status !== "queued" || sub.milestone > goal.milestone) continue;
      const deps = JSON.parse(sub.depends_on) as string[];
      if (!deps.every((d) => merged.has(d))) continue;
      await this.launchSubtask(goal, sub, subs, project.path);
      running++;
    }

    subs = this.h.tasks.children(goalId);
    const stageSubs = subs.filter((s) => s.milestone <= goal.milestone);
    const settled = (s: TaskRow) => s.status === "merged" || s.status === "discarded";
    if (subs.length > 0 && subs.every(settled)) {
      return this.finishGoal(goalId, subs.filter((s) => s.status === "merged"), project.path);
    }
    if (stageSubs.length > 0 && stageSubs.every(settled) && subs.some((s) => !settled(s))) return this.finishStage(goalId, project.path);

    const blocked = subs.filter((s) => !this.h.isRunning(s.id) && ["failed", "stopped", "waiting"].includes(s.status));
    const asking = subs.some((s) => s.status === "waiting" && s.status_reason === "approval");
    const current = this.h.tasks.row(goalId)!;
    if (blocked.length) {
      if (current.status !== "waiting" || current.status_reason !== "subtask_stuck") {
        this.h.finish(goalId, "waiting", "subtask_stuck", blocked.map((s) => s.title).join("; "));
      }
    } else if (asking) {
      if (current.status_reason !== "subtask_waiting") this.h.setStatus(goalId, "waiting", "subtask_waiting");
    } else if (current.status !== "running") {
      this.h.setStatus(goalId, "running", null);
    }
  }

  /** Merges one finished subtask and re-checks the goal. Returns true when the goal must stop and wait. */
  private async mergeOne(goalId: string, sub: TaskRow, repo: string): Promise<boolean> {
    const goal = this.h.tasks.row(goalId)!;
    await snapshot(sub);
    const conflicts = await mergeBranch(goal.worktree, sub.branch, `Merge subtask: ${sub.title}`);
    if (conflicts) {
      this.h.event(goalId, "subtask", { id: sub.plan_id, taskId: sub.id, title: sub.title, action: "conflict", files: conflicts });
      if (sub.requeues >= MAX_REBUILDS) {
        this.h.finish(sub.id, "failed", "conflict", conflicts.join(", "));
        return false;
      }
      await removeWorktree(repo, sub.worktree, sub.branch);
      this.h.tasks.update(sub.id, { requeues: sub.requeues + 1 });
      this.h.setStatus(sub.id, "queued", null);
      this.rebuildNotes.set(
        sub.id,
        `Your previous attempt conflicted with work merged into the goal meanwhile, in: ${conflicts.join(", ")}. ` +
          "Your copy now starts from the current goal branch. Read those files again and redo your part on top of them.",
      );
      return false;
    }

    await removeWorktree(repo, sub.worktree, sub.branch);
    this.merged(goalId, sub);

    // Everything merged so far must still pass its own checks: a merge must not break earlier work.
    const merged = this.h.tasks.children(goalId).filter((s) => s.status === "merged");
    return this.integrate(goalId, [...new Set(merged.flatMap((s) => JSON.parse(s.checks) as string[]))]);
  }

  /**
   * Runs checks on the goal's branch. When they fail, a fix subtask takes over, or after the last allowed
   * fix the goal waits for the user. Returns true when the goal must stop and wait.
   */
  private async integrate(goalId: string, checks: string[]): Promise<boolean> {
    if (checks.length === 0) return false;
    const goal = this.h.tasks.row(goalId)!;
    const results = await runChecks(checks, goal.worktree);
    for (const r of results) this.h.event(goalId, "check", { phase: "integration", ...r });
    if (results.every((r) => r.ok)) return false;

    const report = failureReport(results);
    if (goal.fixes >= MAX_FIXES) {
      this.h.finish(goalId, "waiting", "integration_red", report.slice(0, 4000));
      return true;
    }
    this.addFix(
      goal,
      `After merging the subtasks so far, these checks fail:\n\n${report}\n\nFind the cause and fix it so that every check passes. Do not weaken the tests.`,
      results.filter((r) => !r.ok).map((r) => r.command),
    );
    return false;
  }

  private merged(goalId: string, sub: TaskRow): void {
    this.h.setStatus(sub.id, "merged", null);
    this.h.event(goalId, "subtask", { id: sub.plan_id, taskId: sub.id, title: sub.title, action: "merged" });
  }

  private async launchSubtask(goal: TaskRow, sub: TaskRow, all: TaskRow[], repo: string): Promise<void> {
    const base = await headCommit(goal.worktree);
    await addWorktree(repo, sub.worktree, sub.branch, base);
    const checks = JSON.parse(sub.checks) as string[];
    const stages = JSON.parse(sub.stages) as TaskStages;
    const phase = stages.testsFirst && checks.length > 0 ? "tests" : "code";
    this.h.tasks.update(sub.id, { base_commit: base, phase, attempts: 0 });
    this.h.event(sub.id, "phase", { phase });
    this.h.event(goal.id, "subtask", { id: sub.plan_id, taskId: sub.id, title: sub.title, action: "started" });
    const others = all.filter((o) => o.id !== sub.id).map((o) => ({ planId: o.plan_id ?? o.id, title: o.title }));
    const message = subtaskBrief(
      { planId: sub.plan_id ?? sub.id, title: sub.title, description: sub.task, checks },
      { spec: goal.spec ?? "", checks: JSON.parse(goal.checks) as string[] },
      others,
      this.rebuildNotes.get(sub.id) ?? null,
    );
    this.rebuildNotes.delete(sub.id);
    this.h.launch(sub.id, message);
  }

  /**
   * Every subtask of the current stage is merged: the stage is accepted on its requirements, then the next stage starts,
   * or the goal waits for the user's "Next" when it runs with stops.
   */
  private async finishStage(goalId: string, repo: string): Promise<void> {
    const goal = this.h.tasks.row(goalId)!;
    let summary: string | null = null;
    if ((JSON.parse(goal.requirements) as Requirement[]).some((r) => (r.stage ?? 1) <= goal.milestone)) {
      const verdict = await this.h.accept(goalId);
      if (verdict === null) return;
      if ("message" in verdict) {
        // Fixes of an early stage are held to that stage's own checks: the goal's need every stage.
        const merged = this.h.tasks.children(goalId).filter((s) => s.status === "merged");
        this.addFix(this.h.tasks.row(goalId)!, verdict.message, [...new Set(merged.flatMap((s) => JSON.parse(s.checks) as string[]))], fixTitle(verdict));
        return void this.drive(goalId);
      }
      if (!accepted(verdict)) return this.land(goalId, repo, "acceptance_partial");
      summary = verdict.summary;
    }
    const milestones = JSON.parse(goal.milestones) as Milestone[];
    this.h.event(goalId, "milestone", { stage: goal.milestone, title: milestones[goal.milestone - 1]?.title ?? "", total: milestones.length, summary });
    this.h.tasks.update(goalId, { milestone: goal.milestone + 1, acceptance_rounds: 0, design_reviewed: 0 });
    if ((JSON.parse(goal.stages) as TaskStages).approveSpec) return this.h.finish(goalId, "waiting", "milestone_review");
    return void this.drive(goalId);
  }

  /** "Enough" between stages: what is merged and accepted goes to review. */
  finishEarly(goalId: string): Promise<void> {
    const goal = this.h.tasks.row(goalId)!;
    return this.enqueue(goalId, () => this.land(goalId, this.h.projects.get(goal.project_id)!.path, "milestones_left"));
  }

  private async land(goalId: string, repo: string, reason: string | null): Promise<void> {
    const goal = this.h.tasks.row(goalId)!;
    const subs = this.h.tasks.children(goalId).filter((s) => s.status === "merged");
    const changed = await hasChanges(repo, goal);
    const summary = subs.map((s) => `${s.title}: ${s.summary ?? "—"}`).join("\n");
    this.h.tasks.update(goalId, { summary, commit_message: goal.commit_message ?? goal.title });
    this.h.finish(goalId, changed ? "review" : "done_empty", changed ? reason : null);
  }

  private async finishGoal(goalId: string, subs: TaskRow[], repo: string): Promise<void> {
    // Only now can the goal's own checks pass: they need every subtask.
    if (await this.integrate(goalId, JSON.parse(this.h.tasks.row(goalId)!.checks) as string[])) return;
    // Red checks added a fix subtask: the next round starts it.
    if (this.h.tasks.children(goalId).some((s) => s.status === "queued")) return void this.drive(goalId);
    let reason: string | null = null;
    if ((JSON.parse(this.h.tasks.row(goalId)!.requirements) as unknown[]).length > 0) {
      const verdict = await this.h.accept(goalId);
      if (verdict === null) return;
      if ("message" in verdict) {
        this.addFix(this.h.tasks.row(goalId)!, verdict.message, JSON.parse(this.h.tasks.row(goalId)!.checks) as string[], fixTitle(verdict));
        return void this.drive(goalId);
      }
      if (!accepted(verdict)) reason = "acceptance_partial";
    }
    void subs;
    return this.land(goalId, repo, reason);
  }
}
