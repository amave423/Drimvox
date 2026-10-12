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
  // Spending is history: it stays when a task or project is removed.
  `create table agent_usage (
     task_id text not null,
     input_tokens integer not null,
     output_tokens integer not null,
     cost_usd real not null,
     priced integer not null,
     created_at integer not null
   ) strict;
   create index agent_usage_by_time on agent_usage (created_at);`,
  `alter table tasks add column phase text;
   alter table tasks add column stages text not null default '{"interview":false,"spec":false,"approveSpec":false,"testsFirst":false}';
   alter table tasks add column spec text;
   alter table tasks add column checks text not null default '[]';
   alter table tasks add column plan text not null default '[]';
   alter table tasks add column questions text not null default '[]';
   alter table tasks add column attempts integer not null default 0;
   alter table tasks add column escalated integer not null default 0;
   alter table tasks add column tests_nudged integer not null default 0;`,
  `alter table tasks add column kind text not null default 'solo';
   alter table tasks add column parent_id text references tasks(id) on delete cascade;
   alter table tasks add column plan_id text;
   alter table tasks add column depends_on text not null default '[]';
   alter table tasks add column team text;
   alter table tasks add column planned text not null default '[]';
   alter table tasks add column requeues integer not null default 0;
   alter table tasks add column fixes integer not null default 0;
   create index tasks_by_parent on tasks (parent_id);`,
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
  // Waiting for answers, a spec review or "Continue" survives a restart; a pending command approval does not.
  sql.exec(
    "update tasks set status = 'stopped', status_reason = 'restart' where status = 'running' or (status = 'waiting' and status_reason = 'approval')",
  );
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
