import type { Database } from "../db";

/** A project's own choice among the downloaded skills and the added MCP servers; null: all of them, as before. */
export interface ProjectExtensionsChoice {
  skills: string[] | null;
  mcp: string[] | null;
  /** The model that looks at the screenshots for this project (asked for: in the project, not the settings); null: as before. */
  vision: { providerId: string; model: string } | null;
  /** The cheaper model for sub-agents, summaries and the review in this project (asked for: in the project too). */
  service: { providerId: string; model: string } | null;
}

const key = (projectId: string) => `project.extensions:${projectId}`;

/**
 * Which downloaded skills and MCP servers a project uses (asked for: the settings only download them, each project
 * switches on its own). A project never set keeps every one, as it had before the choice existed.
 */
export class ProjectExtensions {
  constructor(private readonly db: Database) {}

  get(projectId: string): ProjectExtensionsChoice {
    const row = this.db.sql.prepare("select value from settings where key = ?").get(key(projectId)) as { value: string } | undefined;
    if (!row) return { skills: null, mcp: null, vision: null, service: null };
    const kept = JSON.parse(row.value) as Partial<ProjectExtensionsChoice>;
    return { skills: kept.skills ?? null, mcp: kept.mcp ?? null, vision: kept.vision ?? null, service: kept.service ?? null };
  }

  set(projectId: string, patch: Partial<ProjectExtensionsChoice>): ProjectExtensionsChoice {
    const next = { ...this.get(projectId), ...patch };
    this.db.sql
      .prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
      .run(key(projectId), JSON.stringify(next));
    return next;
  }
}
