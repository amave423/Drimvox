import { DatabaseSync } from "node:sqlite";

/** Append-only. Never edit a migration that has shipped; add a new one. */
/**
 * The Playwright server's browser works out of sight (asked for: its window kept jumping in front); "--headed" in the
 * server's command brings it back.
 */
export const HEADLESS_PLAYWRIGHT = `update mcp_servers set args = json_insert(args, '$[#]', '--headless'), updated_at = cast(unixepoch('subsec') * 1000 as integer)
  where args like '%@playwright/mcp%' and args not like '%--headless%' and args not like '%--headed%';`;

/** The Playwright server works only in its own browser, without the user's sign-ins: it asks about nothing. */
export const TRUST_PLAYWRIGHT = `update mcp_servers set trust = 'trusted' where args like '%@playwright/mcp%';`;

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
  `create table media (
     id text primary key,
     kind text not null check (kind in ('image', 'video')),
     mime text not null,
     file text not null,
     prompt text not null,
     provider_id text,
     model text not null,
     cost_usd real,
     chat_id text references chats(id) on delete set null,
     message_id text,
     task_id text references tasks(id) on delete set null,
     path text,
     created_at integer not null
   ) strict;
   create index media_by_time on media (created_at);
   create index media_by_message on media (message_id);
   alter table chats add column kind text not null default 'text';
   alter table messages add column media_job text;`,
  // RouterAI added by hand as a custom provider becomes the RouterAI preset: ruble prices, balance, media.
  `update providers set preset = 'routerai', base_url = 'https://routerai.ru/api/v1'
     where preset = 'custom' and (base_url like 'https://routerai.ru%' or base_url like 'https://www.routerai.ru%');`,
  `create table mcp_servers (
     id text primary key,
     name text not null,
     transport text not null check (transport in ('stdio', 'http')),
     command text,
     args text not null default '[]',
     env_secret text,
     url text,
     headers_secret text,
     enabled integer not null default 1,
     created_at integer not null,
     updated_at integer not null
   ) strict;
   create table mcp_allowed (
     server_id text not null references mcp_servers(id) on delete cascade,
     tool text not null,
     primary key (server_id, tool)
   ) strict;`,
  `alter table tasks add column visual text not null default '[]';
   alter table tasks add column visual_attempts integer not null default 0;`,
  // A command-line agent's own session, continued on the next turn: "<preset>:<model>:<session id>".
  `alter table tasks add column cli_session text;
   alter table chats add column cli_session text;`,
  // Requests of this provider go through the proxy from the settings.
  `alter table providers add column use_proxy integer not null default 0;`,
  // Server mode: signed-in browsers, by the hash of their cookie.
  `create table sessions (
     hash text primary key,
     created_at integer not null,
     expires_at integer not null
   ) strict;`,
  // Numbered requirements of the spec, the agent's own decisions, the acceptance agent's latest verdict.
  `alter table tasks add column requirements text not null default '[]';
   alter table tasks add column decisions text not null default '[]';
   alter table tasks add column acceptance text;
   alter table tasks add column acceptance_rounds integer not null default 0;`,
  // The interview in rounds: how many were asked, what the agent understood and what it still does not know.
  `alter table tasks add column interview_round integer not null default 0;
   alter table tasks add column interview_notes text;`,
  // A big task in stages: their titles and the stage at work (for a subtask, the stage it belongs to).
  `alter table tasks add column milestones text not null default '[]';
   alter table tasks add column milestone integer not null default 1;`,
  // The look: the brief the coders follow, Drimvox's latest design review and whether the current stage had its review.
  `alter table tasks add column design text;
   alter table tasks add column design_review text;
   alter table tasks add column design_reviewed integer not null default 0;`,
  // How many times a task on its own went past the step limit without asking.
  `alter table tasks add column step_rounds integer not null default 0;`,
  // How red the checks were at the last step limit, to tell progress from going in circles.
  `alter table tasks add column step_red integer;`,
  // The summary that stands for the agent's older work once its conversation nears the model's context (memory.ts).
  `alter table tasks add column memory text;`,
  // The project's task list and what its tasks share (docs/specs/backlog-loop.md).
  `create table backlog (
     id text primary key,
     project_id text not null references projects(id) on delete cascade,
     position integer not null,
     title text not null,
     done text not null default '[]',
     size text not null,
     status text not null default 'open',
     task_id text,
     created_at integer not null
   ) strict;
   create index backlog_project on backlog(project_id, position);
   create table project_plans (
     project_id text primary key references projects(id) on delete cascade,
     data text not null
   ) strict;`,
  // A chat working in a folder, and the snapshot of that folder before each answer (docs/specs/chat-folder.md).
  `alter table chats add column folder text;
   alter table messages add column checkpoint text;`,
  // Files attached to chat messages and what was read out of them (docs/specs/chat-attachments.md).
  `create table attachments (
     id text primary key,
     chat_id text not null references chats(id) on delete cascade,
     message_id text,
     name text not null,
     type text not null,
     size integer not null,
     kind text not null,
     text text,
     created_at integer not null
   ) strict;
   create index attachments_message on attachments(message_id);`,
  // A task of the list is a conversation in the project's folder (docs/specs/project-work.md).
  `alter table chats add column project_id text;
   alter table chats add column item_id text;
   alter table backlog add column chat_id text;
   alter table backlog add column checkpoint text;`,
  // What the model did while answering (its tool calls), kept with the answer.
  `alter table messages add column activity text;`,
  // Work on a project: the interview, the plan, then one long run in the project's conversation (docs/specs/project-work.md).
  `create table project_work (
     project_id text primary key references projects(id) on delete cascade,
     status text not null default 'idle',
     reason text,
     detail text,
     models text,
     plan_task_id text,
     chat_id text,
     checklist text not null default '[]',
     questions text not null default '[]',
     shots text not null default '[]',
     budget_usd real not null default 1,
     hours real not null default 2,
     worked_ms integer not null default 0,
     escalated integer not null default 0,
     started_at integer
   ) strict;`,
  // When the chat was last looked at: an answer that came after it shows as unread in the list.
  `alter table chats add column seen_at integer;
   update chats set seen_at = updated_at;`,
  // A project's finished work: the agent's report, and how to start what it made (docs/specs/project-work.md).
  `alter table project_work add column report text;
   alter table project_work add column site_command text;
   alter table project_work add column site_url text;`,
  // An edited message starts a branch (docs/specs/chats.md): each message knows the one before it, the chat its branch.
  `alter table messages add column parent_id text;
   alter table chats add column head_id text;
   update messages set parent_id = (
     select p.id from messages p where p.chat_id = messages.chat_id
       and (p.created_at < messages.created_at or (p.created_at = messages.created_at and p.rowid < messages.rowid))
     order by p.created_at desc, p.rowid desc limit 1);
   update chats set head_id = (select m.id from messages m where m.chat_id = chats.id order by m.created_at desc, m.rowid desc limit 1);`,
  // A provider paid by a flat fee, not by tokens (a reseller's subscription): its models are free to Drimvox.
  `alter table providers add column flat integer not null default 0;`,
  HEADLESS_PLAYWRIGHT,
  // How much a server is trusted: a new one asks only about what changes something.
  `alter table mcp_servers add column trust text not null default 'changes'; ${TRUST_PLAYWRIGHT}`,
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
  // A clip being made on the provider's side is still coming: its job id is kept and polled again.
  sql.exec("update messages set status = 'stopped' where status = 'streaming' and media_job is null");
  // Agent tasks live in memory while they run; after a restart they can only be resumed by hand.
  // Waiting for answers, a spec review or "Continue" survives a restart; a pending command approval does not.
  sql.exec(
    "update tasks set status = 'stopped', status_reason = 'restart' where status = 'running' or (status = 'waiting' and status_reason = 'approval')",
  );
  // A project's run lives in memory too: after a restart it continues by hand.
  sql.exec("update project_work set status = 'stopped', reason = 'restart' where status = 'running'");
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
