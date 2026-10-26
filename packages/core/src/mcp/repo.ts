import type { McpServerView, McpTrust } from "@drimvox/shared";
import { randomUUID } from "node:crypto";
import type { Database } from "../db";
import type { Cipher } from "../secrets";

interface Row {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string;
  env_secret: string | null;
  url: string | null;
  headers_secret: string | null;
  enabled: number;
  trust: McpTrust;
  created_at: number;
  updated_at: number;
}

/** What is needed to reach a server; secrets decrypted. Lives only inside the core. */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  trust: McpTrust;
  /** Changes when the server is edited, so a stale connection is replaced. */
  version: number;
}

export interface NewMcpServer {
  name: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  trust: McpTrust;
}

export class McpRepo {
  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher,
  ) {}

  list(): McpServerView[] {
    return this.rows().map((r) => this.view(r));
  }

  get(id: string): McpServerView | null {
    const row = this.row(id);
    return row ? this.view(row) : null;
  }

  create(s: NewMcpServer): McpServerView {
    const now = Date.now();
    const row: Row = {
      id: randomUUID(),
      name: s.name,
      transport: s.command ? "stdio" : "http",
      command: s.command ?? null,
      args: JSON.stringify(s.args),
      env_secret: Object.keys(s.env).length ? this.cipher.encrypt(JSON.stringify(s.env)) : null,
      url: s.url ?? null,
      headers_secret: Object.keys(s.headers).length ? this.cipher.encrypt(JSON.stringify(s.headers)) : null,
      enabled: 1,
      trust: s.trust,
      created_at: now,
      updated_at: now,
    };
    const cols = Object.keys(row);
    this.db.sql
      .prepare(`insert into mcp_servers (${cols.join(", ")}) values (${cols.map((c) => `:${c}`).join(", ")})`)
      .run(row as unknown as Record<string, string | number | null>);
    return this.view(row);
  }

  update(id: string, patch: { name?: string; enabled?: boolean; trust?: McpTrust }): McpServerView | null {
    const row = this.row(id);
    if (!row) return null;
    this.db.sql
      .prepare("update mcp_servers set name = ?, enabled = ?, trust = ?, updated_at = ? where id = ?")
      .run(patch.name ?? row.name, patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0, patch.trust ?? row.trust, Date.now(), id);
    return this.get(id);
  }

  remove(id: string): boolean {
    return Number(this.db.sql.prepare("delete from mcp_servers where id = ?").run(id).changes) > 0;
  }

  /** Enabled servers with their secrets, for connecting. */
  enabled(): McpServerConfig[] {
    return this.rows()
      .filter((r) => r.enabled === 1)
      .map((r) => this.config(r));
  }

  config(idOrRow: string | Row): McpServerConfig {
    const r = typeof idOrRow === "string" ? this.row(idOrRow)! : idOrRow;
    return {
      id: r.id,
      name: r.name,
      transport: r.transport,
      command: r.command,
      args: JSON.parse(r.args) as string[],
      env: this.secret(r.env_secret),
      url: r.url,
      headers: this.secret(r.headers_secret),
      trust: r.trust,
      version: r.updated_at,
    };
  }

  isAllowed(serverId: string, tool: string): boolean {
    // "*": the user trusted the whole server.
    return !!this.db.sql.prepare("select 1 from mcp_allowed where server_id = ? and tool in (?, '*')").get(serverId, tool);
  }

  allow(serverId: string, tool: string): void {
    this.db.sql.prepare("insert or ignore into mcp_allowed values (?, ?)").run(serverId, tool);
  }

  disallow(serverId: string, tool: string): boolean {
    return Number(this.db.sql.prepare("delete from mcp_allowed where server_id = ? and tool = ?").run(serverId, tool).changes) > 0;
  }

  private secret(blob: string | null): Record<string, string> {
    if (!blob) return {};
    try {
      return JSON.parse(this.cipher.decrypt(blob)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private view(r: Row): McpServerView {
    const allowed = this.db.sql.prepare("select tool from mcp_allowed where server_id = ? order by tool").all(r.id) as { tool: string }[];
    return {
      id: r.id,
      name: r.name,
      transport: r.transport,
      command: r.command,
      args: JSON.parse(r.args) as string[],
      envKeys: Object.keys(this.secret(r.env_secret)),
      url: r.url,
      headerKeys: Object.keys(this.secret(r.headers_secret)),
      enabled: r.enabled === 1,
      trust: r.trust,
      allowed: allowed.map((a) => a.tool),
      createdAt: r.created_at,
    };
  }

  private row(id: string): Row | undefined {
    return this.db.sql.prepare("select * from mcp_servers where id = ?").get(id) as Row | undefined;
  }

  private rows(): Row[] {
    return this.db.sql.prepare("select * from mcp_servers order by created_at").all() as unknown as Row[];
  }
}
