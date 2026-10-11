import { DatabaseSync } from "node:sqlite";

/** Append-only. Never edit a migration that has shipped; add a new one. */
const migrations: string[] = [
  `create table settings (key text primary key, value text not null) strict;`,
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
