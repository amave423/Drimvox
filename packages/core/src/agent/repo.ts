import type { ProjectView, TaskEvent, TaskEventKind, TaskStatus, TaskView } from "@artel/shared";
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
  >
>;

export class TaskRepo {
  constructor(private readonly db: Database) {}

  row(id: string): TaskRow | null {
    return (this.db.sql.prepare("select * from tasks where id = ?").get(id) as TaskRow | undefined) ?? null;
  }

  list(projectId?: string): TaskRow[] {
    const sql = projectId
      ? this.db.sql.prepare("select * from tasks where project_id = ? order by created_at desc")
      : this.db.sql.prepare("select * from tasks order by created_at desc");
    return (projectId ? sql.all(projectId) : sql.all()) as unknown as TaskRow[];
  }

  create(row: Omit<TaskRow, "cost_usd" | "input_tokens" | "output_tokens" | "steps" | "summary" | "commit_message" | "messages" | "created_at" | "updated_at" | "status_reason">): TaskRow {
    const now = Date.now();
    const full: TaskRow = {
      ...row,
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

export function toTaskView(row: TaskRow, pendingApproval: TaskView["pendingApproval"]): TaskView {
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
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    steps: row.steps,
    summary: row.summary,
    commitMessage: row.commit_message,
    pendingApproval,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
