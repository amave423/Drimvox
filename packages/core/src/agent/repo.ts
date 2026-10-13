import type { AcceptanceReport, DesignBrief, DesignReview, Milestone, Requirement } from "@artel/shared";
import { MAX_INTERVIEW_ROUNDS } from "./phases";
import type {
  ModelRef,
  PlannedSubtask,
  ProjectView,
  Question,
  SubtaskCard,
  TaskEvent,
  TaskEventKind,
  TaskKind,
  TaskPhase,
  TaskStatus,
  TaskStages,
  TaskView,
  VisualCheck,
} from "@artel/shared";
import type { ModelMessage } from "ai";
import { randomUUID } from "node:crypto";
import type { Database } from "../db";

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  task: string;
  provider_id: string | null;
  model: string;
  status: TaskStatus;
  status_reason: string | null;
  branch: string;
  worktree: string;
  base_commit: string;
  budget_usd: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  steps: number;
  summary: string | null;
  commit_message: string | null;
  messages: string;
  created_at: number;
  updated_at: number;
  phase: TaskPhase | null;
  stages: string;
  spec: string | null;
  checks: string;
  plan: string;
  questions: string;
  attempts: number;
  escalated: number;
  tests_nudged: number;
  kind: TaskKind;
  parent_id: string | null;
  plan_id: string | null;
  depends_on: string;
  team: string | null;
  planned: string;
  requeues: number;
  fixes: number;
  visual: string;
  visual_attempts: number;
  cli_session: string | null;
  requirements: string;
  decisions: string;
  acceptance: string | null;
  acceptance_rounds: number;
  interview_round: number;
  interview_notes: string | null;
  milestones: string;
  milestone: number;
  design: string | null;
  design_review: string | null;
  design_reviewed: number;
}

export class ProjectRepo {
  constructor(private readonly db: Database) {}

  list(): Omit<ProjectView, "gitState">[] {
    return (this.db.sql.prepare("select * from projects order by created_at").all() as unknown as ProjectRow[]).map(toProject);
  }

  get(id: string): Omit<ProjectView, "gitState"> | null {
    const row = this.db.sql.prepare("select * from projects where id = ?").get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  findByPath(path: string): Omit<ProjectView, "gitState"> | null {
    const row = this.db.sql.prepare("select * from projects where path = ?").get(path) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  create(name: string, path: string): Omit<ProjectView, "gitState"> {
    const row: ProjectRow = { id: randomUUID(), name, path, created_at: Date.now() };
    this.db.sql.prepare("insert into projects values (:id, :name, :path, :created_at)").run({ ...row });
    return toProject(row);
  }

  remove(id: string): boolean {
    return Number(this.db.sql.prepare("delete from projects where id = ?").run(id).changes) > 0;
  }
}

export type TaskPatch = Partial<
  Pick<
    TaskRow,
    | "status"
    | "status_reason"
    | "budget_usd"
    | "cost_usd"
    | "input_tokens"
    | "output_tokens"
    | "steps"
    | "summary"
    | "commit_message"
    | "messages"
    | "phase"
    | "spec"
    | "checks"
    | "plan"
    | "questions"
    | "attempts"
    | "escalated"
    | "tests_nudged"
    | "provider_id"
    | "model"
    | "branch"
    | "worktree"
    | "base_commit"
    | "planned"
    | "requeues"
    | "fixes"
    | "depends_on"
    | "visual"
    | "visual_attempts"
    | "cli_session"
    | "requirements"
    | "decisions"
    | "acceptance"
    | "acceptance_rounds"
    | "interview_round"
    | "interview_notes"
    | "milestones"
    | "milestone"
    | "design"
    | "design_review"
    | "design_reviewed"
  >
>;

export class TaskRepo {
  constructor(private readonly db: Database) {}

  row(id: string): TaskRow | null {
    return (this.db.sql.prepare("select * from tasks where id = ?").get(id) as TaskRow | undefined) ?? null;
  }

  /** Top-level tasks: one-agent tasks and goals. Subtasks belong to their goal. */
  list(projectId?: string): TaskRow[] {
    const sql = projectId
      ? this.db.sql.prepare("select * from tasks where project_id = ? and kind <> 'subtask' order by created_at desc")
      : this.db.sql.prepare("select * from tasks where kind <> 'subtask' order by created_at desc");
    return (projectId ? sql.all(projectId) : sql.all()) as unknown as TaskRow[];
  }

  /** A goal's subtasks in the order they were planned. */
  children(goalId: string): TaskRow[] {
    return this.db.sql.prepare("select * from tasks where parent_id = ? order by created_at, rowid").all(goalId) as unknown as TaskRow[];
  }

  create(
    row: Pick<TaskRow, "id" | "project_id" | "title" | "task" | "provider_id" | "model" | "status" | "branch" | "worktree" | "base_commit" | "budget_usd">,
    stages: TaskStages,
    extra: Partial<Pick<TaskRow, "kind" | "parent_id" | "plan_id" | "depends_on" | "team" | "checks" | "spec" | "milestone" | "design" | "visual">> = {},
  ): TaskRow {
    const now = Date.now();
    const full: TaskRow = {
      ...row,
      phase: null,
      stages: JSON.stringify(stages),
      spec: null,
      checks: "[]",
      plan: "[]",
      questions: "[]",
      attempts: 0,
      escalated: 0,
      tests_nudged: 0,
      kind: "solo",
      parent_id: null,
      plan_id: null,
      depends_on: "[]",
      team: null,
      planned: "[]",
      requeues: 0,
      fixes: 0,
      visual: "[]",
      visual_attempts: 0,
      cli_session: null,
      requirements: "[]",
      decisions: "[]",
      acceptance: null,
      acceptance_rounds: 0,
      interview_round: 0,
      interview_notes: null,
      milestones: "[]",
      milestone: 1,
      design: null,
      design_review: null,
      design_reviewed: 0,
      ...extra,
      status_reason: null,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      steps: 0,
      summary: null,
      commit_message: null,
      messages: "[]",
      created_at: now,
      updated_at: now,
    };
    const cols = Object.keys(full);
    this.db.sql
      .prepare(`insert into tasks (${cols.join(", ")}) values (${cols.map((c) => `:${c}`).join(", ")})`)
      .run(full as unknown as Record<string, string | number | null>);
    return full;
  }

  update(id: string, patch: TaskPatch): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const set = [...entries.map(([k]) => `${k} = :${k}`), "updated_at = :updated_at"].join(", ");
    this.db.sql
      .prepare(`update tasks set ${set} where id = :id`)
      .run({ ...Object.fromEntries(entries), updated_at: Date.now(), id } as Record<string, string | number | null>);
  }

  messages(id: string): ModelMessage[] {
    return JSON.parse(this.row(id)?.messages ?? "[]") as ModelMessage[];
  }

  /** One agent step's spending, for the day's total. */
  addUsage(taskId: string, inputTokens: number, outputTokens: number, costUsd: number, priced: boolean): void {
    this.db.sql
      .prepare("insert into agent_usage values (?, ?, ?, ?, ?, ?)")
      .run(taskId, inputTokens, outputTokens, costUsd, priced ? 1 : 0, Date.now());
  }

  addEvent(taskId: string, kind: TaskEventKind, data: unknown): TaskEvent {
    const last = this.db.sql.prepare("select coalesce(max(seq), 0) as seq from task_events where task_id = ?").get(taskId) as {
      seq: number;
    };
    const event: TaskEvent = { seq: last.seq + 1, kind, data, createdAt: Date.now() };
    this.db.sql
      .prepare("insert into task_events values (?, ?, ?, ?, ?)")
      .run(taskId, event.seq, kind, JSON.stringify(data), event.createdAt);
    return event;
  }

  events(taskId: string, after = 0): TaskEvent[] {
    const rows = this.db.sql
      .prepare("select seq, kind, data, created_at from task_events where task_id = ? and seq > ? order by seq")
      .all(taskId, after) as { seq: number; kind: TaskEventKind; data: string; created_at: number }[];
    return rows.map((r) => ({ seq: r.seq, kind: r.kind, data: JSON.parse(r.data), createdAt: r.created_at }));
  }
}

function toProject(row: ProjectRow): Omit<ProjectView, "gitState"> {
  return { id: row.id, name: row.name, path: row.path, createdAt: row.created_at };
}

export function toSubtaskCard(row: TaskRow): SubtaskCard {
  return {
    id: row.plan_id ?? row.id,
    taskId: row.id,
    title: row.title,
    status: row.status,
    statusReason: row.status_reason,
    phase: row.phase,
    model: row.model,
    costUsd: row.cost_usd,
    dependsOn: JSON.parse(row.depends_on) as string[],
  };
}

export function toTaskView(row: TaskRow, pendingApproval: TaskView["pendingApproval"], children: TaskRow[] = []): TaskView {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    task: row.task,
    providerId: row.provider_id,
    model: row.model,
    status: row.status,
    statusReason: row.status_reason,
    branch: row.branch,
    budgetUsd: row.budget_usd,
    // A goal costs what its lead and every subtask cost together.
    costUsd: row.cost_usd + children.reduce((s, c) => s + c.cost_usd, 0),
    inputTokens: row.input_tokens + children.reduce((s, c) => s + c.input_tokens, 0),
    outputTokens: row.output_tokens + children.reduce((s, c) => s + c.output_tokens, 0),
    steps: row.steps + children.reduce((s, c) => s + c.steps, 0),
    summary: row.summary,
    commitMessage: row.commit_message,
    pendingApproval,
    phase: row.phase,
    stages: JSON.parse(row.stages) as TaskStages,
    spec: row.spec,
    checks: JSON.parse(row.checks) as string[],
    plan: JSON.parse(row.plan) as string[],
    questions: JSON.parse(row.questions) as Question[],
    attempts: row.attempts,
    escalated: row.escalated === 1,
    kind: row.kind,
    parentId: row.parent_id,
    team: row.team ? (JSON.parse(row.team) as ModelRef) : null,
    plannedSubtasks: JSON.parse(row.planned) as PlannedSubtask[],
    visualChecks: JSON.parse(row.visual) as VisualCheck[],
    subtasks: children.map(toSubtaskCard),
    requirements: JSON.parse(row.requirements) as Requirement[],
    decisions: JSON.parse(row.decisions) as string[],
    acceptance: row.acceptance ? (JSON.parse(row.acceptance) as AcceptanceReport) : null,
    milestones: JSON.parse(row.milestones) as Milestone[],
    milestone: row.milestone,
    design: row.design ? (JSON.parse(row.design) as DesignBrief) : null,
    designReview: row.design_review ? (JSON.parse(row.design_review) as DesignReview) : null,
    interview: row.interview_round > 0 ? { round: row.interview_round, maxRounds: MAX_INTERVIEW_ROUNDS, ...notesOf(row) } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function notesOf(row: TaskRow): { understood: string; unknown: string[] } {
  const notes = row.interview_notes ? (JSON.parse(row.interview_notes) as { understood?: string; unknown?: string[] }) : {};
  return { understood: notes.understood ?? "", unknown: notes.unknown ?? [] };
}
