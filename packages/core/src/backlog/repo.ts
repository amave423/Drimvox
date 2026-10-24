import type { BacklogItem, BacklogItemInput, BacklogStatus, ProjectPlan } from "@drimvox/shared";
import { randomUUID } from "node:crypto";
import type { Database } from "../db";

interface Row {
  id: string;
  project_id: string;
  position: number;
  title: string;
  done: string;
  size: BacklogItem["size"];
  status: BacklogStatus;
  task_id: string | null;
  chat_id: string | null;
  checkpoint: string | null;
  created_at: number;
}

const toItem = (r: Row): BacklogItem => ({
  id: r.id,
  projectId: r.project_id,
  position: r.position,
  title: r.title,
  done: JSON.parse(r.done) as string[],
  size: r.size,
  status: r.status,
  taskId: r.task_id,
  chatId: r.chat_id ?? null,
});

/** The project's task list and the plan its tasks share. */
export class BacklogRepo {
  constructor(private readonly db: Database) {}

  list(projectId: string): BacklogItem[] {
    return (this.db.sql.prepare("select * from backlog where project_id = ? order by position, created_at").all(projectId) as unknown as Row[]).map(toItem);
  }

  get(id: string): BacklogItem | null {
    const row = this.db.sql.prepare("select * from backlog where id = ?").get(id) as Row | undefined;
    return row ? toItem(row) : null;
  }

  byChat(chatId: string): BacklogItem | null {
    const row = this.db.sql.prepare("select * from backlog where chat_id = ?").get(chatId) as Row | undefined;
    return row ? toItem(row) : null;
  }

  /** The folder's snapshot from before the task started, to roll it back to. */
  checkpoint(id: string): string | null {
    return (this.db.sql.prepare("select checkpoint from backlog where id = ?").get(id) as { checkpoint: string | null } | undefined)?.checkpoint ?? null;
  }

  byTask(taskId: string): BacklogItem | null {
    const row = this.db.sql.prepare("select * from backlog where task_id = ?").get(taskId) as Row | undefined;
    return row ? toItem(row) : null;
  }

  /** Adds tasks at the end of the list, in the order given. */
  add(projectId: string, items: BacklogItemInput[]): BacklogItem[] {
    const last = this.db.sql.prepare("select coalesce(max(position), 0) as p from backlog where project_id = ?").get(projectId) as { p: number };
    const insert = this.db.sql.prepare(
      "insert into backlog (id, project_id, position, title, done, size, status, task_id, created_at) values (?, ?, ?, ?, ?, ?, 'open', null, ?)",
    );
    const ids = items.map((item, i) => {
      const id = randomUUID();
      insert.run(id, projectId, last.p + i + 1, item.title, JSON.stringify(item.done), item.size, Date.now());
      return id;
    });
    return ids.map((id) => this.get(id)!);
  }

  update(
    id: string,
    patch: Partial<{ title: string; done: string[]; size: BacklogItem["size"]; status: BacklogStatus; taskId: string | null; chatId: string | null; checkpoint: string | null; position: number }>,
  ): void {
    const columns: Record<string, string | number | null> = {};
    if (patch.title !== undefined) columns.title = patch.title;
    if (patch.done !== undefined) columns.done = JSON.stringify(patch.done);
    if (patch.size !== undefined) columns.size = patch.size;
    if (patch.status !== undefined) columns.status = patch.status;
    if (patch.taskId !== undefined) columns.task_id = patch.taskId;
    if (patch.chatId !== undefined) columns.chat_id = patch.chatId;
    if (patch.checkpoint !== undefined) columns.checkpoint = patch.checkpoint;
    if (patch.position !== undefined) columns.position = patch.position;
    const keys = Object.keys(columns);
    if (keys.length === 0) return;
    this.db.sql.prepare(`update backlog set ${keys.map((k) => `${k} = :${k}`).join(", ")} where id = :id`).run({ ...columns, id });
  }

  remove(id: string): boolean {
    return Number(this.db.sql.prepare("delete from backlog where id = ?").run(id).changes) > 0;
  }

  /** Puts the given tasks first, in that order; the rest keep theirs after them. */
  reorder(projectId: string, ids: string[]): void {
    const rest = this.list(projectId).filter((i) => !ids.includes(i.id));
    [...ids.map((id) => this.get(id)).filter((i): i is BacklogItem => i?.projectId === projectId), ...rest].forEach((item, n) =>
      this.update(item.id, { position: n + 1 }),
    );
  }

  plan(projectId: string): ProjectPlan | null {
    const row = this.db.sql.prepare("select data from project_plans where project_id = ?").get(projectId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ProjectPlan) : null;
  }

  setPlan(projectId: string, plan: ProjectPlan): void {
    this.db.sql
      .prepare("insert into project_plans (project_id, data) values (?, ?) on conflict(project_id) do update set data = excluded.data")
      .run(projectId, JSON.stringify(plan));
  }
}
