import { DatabaseSync } from "node:sqlite";

/** Append-only. Never edit a migration that has shipped; add a new one. */
const migrations: string[] = [
  `create table settings (key text primary key, value text not null) strict;`,
  `create table providers (
     id text primary key,
     preset text not null,
     name text not null,
     base_url text not null,
     secret text,
     created_at integer not null,
     updated_at integer not null
   ) strict;
   create table chats (
     id text primary key,
     title text,
     provider_id text references providers(id) on delete set null,
     model text,
     created_at integer not null,
     updated_at integer not null
   ) strict;
   create table messages (
     id text primary key,
     chat_id text not null references chats(id) on delete cascade,
     role text not null check (role in ('user', 'assistant')),
     content text not null,
     reasoning text,
     provider_id text,
     model text,
     input_tokens integer,
     output_tokens integer,
     cost_usd real,
     status text not null default 'done' check (status in ('done', 'streaming', 'stopped', 'error')),
     error_code text,
     error_detail text,
     created_at integer not null
   ) strict;
   create index messages_by_chat on messages (chat_id, created_at);
   create index messages_by_time on messages (created_at);`,
  `create table projects (
     id text primary key,
     name text not null,
     path text not null unique,
     created_at integer not null
   ) strict;
   create table tasks (
     id text primary key,
     project_id text not null references projects(id) on delete cascade,
     title text not null,
     task text not null,
     provider_id text references providers(id) on delete set null,
     model text not null,
     status text not null,
     status_reason text,
     branch text not null,
     worktree text not null,
     base_commit text not null,
     budget_usd real not null,
     cost_usd real not null default 0,
     input_tokens integer not null default 0,
     output_tokens integer not null default 0,
     steps integer not null default 0,
     summary text,
     commit_message text,
     messages text not null default '[]',
     created_at integer not null,
     updated_at integer not null
   ) strict;
   create index tasks_by_project on tasks (project_id, created_at);
   create table task_events (
     task_id text not null references tasks(id) on delete cascade,
     seq integer not null,
     kind text not null,
     data text not null,
     created_at integer not null,
     primary key (task_id, seq)
   ) strict;`,
];

export interface Database {
  sql: DatabaseSync;
  schemaVersion(): number;
  close(): void;
}

export function openDatabase(file: string): Database {
  const sql = new DatabaseSync(file);
  sql.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  migrate(sql);
  // Answers that were streaming when the app died will never finish.
  sql.exec("update messages set status = 'stopped' where status = 'streaming'");
  // Agent tasks live in memory while they run; after a restart they can only be resumed by hand.
  sql.exec("update tasks set status = 'stopped', status_reason = 'restart' where status in ('running', 'waiting')");
  return {
    sql,
    schemaVersion: () => readVersion(sql),
    close: () => sql.close(),
  };
}

function readVersion(sql: DatabaseSync): number {
  const row = sql.prepare("pragma user_version").get() as { user_version: number };
  return row.user_version;
}

function migrate(sql: DatabaseSync): void {
  for (let v = readVersion(sql); v < migrations.length; v++) {
    sql.exec("begin");
    try {
      sql.exec(migrations[v]!);
      sql.exec(`pragma user_version = ${v + 1}`);
      sql.exec("commit");
    } catch (err) {
      sql.exec("rollback");
      throw err;
    }
  }
}
