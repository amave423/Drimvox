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
