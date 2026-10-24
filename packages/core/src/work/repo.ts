import type { AgentQuestion, ChecklistItem, ProjectModels, ProjectWorkReason, ProjectWorkStatus, WorkShot } from "@drimvox/shared";
import type { Database } from "../db";

interface Row {
  project_id: string;
  status: ProjectWorkStatus;
  reason: ProjectWorkReason | null;
  detail: string | null;
  models: string | null;
  plan_task_id: string | null;
  chat_id: string | null;
  checklist: string;
  questions: string;
  shots: string;
  budget_usd: number;
  hours: number;
  worked_ms: number;
  escalated: number;
  started_at: number | null;
}

export interface WorkRow {
  projectId: string;
  status: ProjectWorkStatus;
  reason: ProjectWorkReason | null;
  detail: string | null;
  models: ProjectModels | null;
  planTaskId: string | null;
  chatId: string | null;
  checklist: ChecklistItem[];
  questions: AgentQuestion[];
  shots: WorkShot[];
  budgetUsd: number;
  hours: number;
  workedMs: number;
  escalated: boolean;
  startedAt: number | null;
}

const toWork = (r: Row): WorkRow => ({
  projectId: r.project_id,
  status: r.status,
  reason: r.reason,
  detail: r.detail,
  models: r.models ? (JSON.parse(r.models) as ProjectModels) : null,
  planTaskId: r.plan_task_id,
  chatId: r.chat_id,
  checklist: JSON.parse(r.checklist) as ChecklistItem[],
  questions: JSON.parse(r.questions) as AgentQuestion[],
  shots: JSON.parse(r.shots) as WorkShot[],
  budgetUsd: r.budget_usd,
  hours: r.hours,
  workedMs: r.worked_ms,
  escalated: r.escalated === 1,
  startedAt: r.started_at,
});

/** Screenshots kept per project: the newest; older ones stay on disk with the task screenshots. */
const MAX_SHOTS = 24;

/** A project's work: who does what, the plan's task, the conversation, the checklist and the limits. */
export class ProjectWorkRepo {
  constructor(private readonly db: Database) {}

  get(projectId: string): WorkRow | null {
    const row = this.db.sql.prepare("select * from project_work where project_id = ?").get(projectId) as Row | undefined;
    return row ? toWork(row) : null;
  }

  /** Every project with work, for the notifications. */
  projectIds(): string[] {
    return (this.db.sql.prepare("select project_id from project_work").all() as { project_id: string }[]).map((r) => r.project_id);
  }

  byChat(chatId: string): WorkRow | null {
    const row = this.db.sql.prepare("select * from project_work where chat_id = ?").get(chatId) as Row | undefined;
    return row ? toWork(row) : null;
  }

  byPlanTask(taskId: string): WorkRow | null {
    const row = this.db.sql.prepare("select * from project_work where plan_task_id = ?").get(taskId) as Row | undefined;
    return row ? toWork(row) : null;
  }

  update(projectId: string, patch: Partial<Omit<WorkRow, "projectId">>): WorkRow {
    this.db.sql.prepare("insert into project_work (project_id) values (?) on conflict(project_id) do nothing").run(projectId);
    const columns: Record<string, string | number | null> = {};
    const json = (v: unknown) => JSON.stringify(v);
    if (patch.status !== undefined) columns.status = patch.status;
    if (patch.reason !== undefined) columns.reason = patch.reason;
    if (patch.detail !== undefined) columns.detail = patch.detail;
    if (patch.models !== undefined) columns.models = patch.models ? json(patch.models) : null;
    if (patch.planTaskId !== undefined) columns.plan_task_id = patch.planTaskId;
    if (patch.chatId !== undefined) columns.chat_id = patch.chatId;
    if (patch.checklist !== undefined) columns.checklist = json(patch.checklist);
    if (patch.questions !== undefined) columns.questions = json(patch.questions);
    if (patch.shots !== undefined) columns.shots = json(patch.shots.slice(-MAX_SHOTS));
    if (patch.budgetUsd !== undefined) columns.budget_usd = patch.budgetUsd;
    if (patch.hours !== undefined) columns.hours = patch.hours;
    if (patch.workedMs !== undefined) columns.worked_ms = Math.round(patch.workedMs);
    if (patch.escalated !== undefined) columns.escalated = patch.escalated ? 1 : 0;
    if (patch.startedAt !== undefined) columns.started_at = patch.startedAt;
    const keys = Object.keys(columns);
    if (keys.length) {
      this.db.sql.prepare(`update project_work set ${keys.map((k) => `${k} = :${k}`).join(", ")} where project_id = :id`).run({ ...columns, id: projectId });
    }
    return this.get(projectId)!;
  }

  /** What the project's conversation cost and how many tools it called since the work started. */
  spending(chatId: string, since: number): { spentUsd: number; actions: number } {
    const rows = this.db.sql
      .prepare("select cost_usd, activity from messages where chat_id = ? and role = 'assistant' and created_at >= ?")
      .all(chatId, since) as { cost_usd: number | null; activity: string | null }[];
    return {
      spentUsd: rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0),
      actions: rows.reduce((sum, r) => sum + (r.activity ? (JSON.parse(r.activity) as unknown[]).length : 0), 0),
    };
  }
}
