import type { ProjectKind, ProjectView } from "@drimvox/shared";
import { randomUUID } from "node:crypto";
import type { Database } from "../db";

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  kind: ProjectKind;
  created_at: number;
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

  create(name: string, path: string, kind: ProjectKind = "new"): Omit<ProjectView, "gitState"> {
    const row: ProjectRow = { id: randomUUID(), name, path, kind, created_at: Date.now() };
    this.db.sql.prepare("insert into projects (id, name, path, kind, created_at) values (:id, :name, :path, :kind, :created_at)").run({ ...row });
    return toProject(row);
  }

  setKind(id: string, kind: ProjectKind): Omit<ProjectView, "gitState"> | null {
    this.db.sql.prepare("update projects set kind = ? where id = ?").run(kind, id);
    return this.get(id);
  }

  rename(id: string, name: string): Omit<ProjectView, "gitState"> | null {
    this.db.sql.prepare("update projects set name = ? where id = ?").run(name, id);
    return this.get(id);
  }

  remove(id: string): boolean {
    return Number(this.db.sql.prepare("delete from projects where id = ?").run(id).changes) > 0;
  }

  /** The project's conversations, whose marks in git tell its folder (relocate.ts). */
  chatIds(id: string): string[] {
    return (this.db.sql.prepare("select id from chats where project_id = ?").all(id) as { id: string }[]).map((r) => r.id);
  }

  /** The project's folder is elsewhere now (renamed or moved): the project and its conversations follow it. */
  move(id: string, path: string): Omit<ProjectView, "gitState"> | null {
    const old = this.get(id);
    if (!old) return null;
    this.db.sql.prepare("update projects set path = ? where id = ?").run(path, id);
    this.db.sql.prepare("update chats set folder = ? where project_id = ? or folder = ?").run(path, id, old.path);
    return this.get(id);
  }
}

function toProject(row: ProjectRow): Omit<ProjectView, "gitState"> {
  return { id: row.id, name: row.name, path: row.path, kind: row.kind, createdAt: row.created_at };
}
