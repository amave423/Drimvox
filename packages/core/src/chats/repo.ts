import type { ChatKind, ChatUpdate, ChatView, ChatWithMessages, MessageStatus, MessageView, ProviderError, UsageSummary } from "@artel/shared";
import { randomUUID } from "node:crypto";
import type { Database } from "../db";
import type { MediaRepo } from "../media/repo";

interface ChatRow {
  id: string;
  title: string | null;
  provider_id: string | null;
  model: string | null;
  kind: ChatKind;
  folder: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string | null;
  provider_id: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  status: MessageStatus;
  error_code: string | null;
  error_detail: string | null;
  created_at: number;
  media_job: string | null;
  checkpoint: string | null;
}

/** A clip the provider is still rendering for an answer. */
export interface PendingJob {
  messageId: string;
  chatId: string;
  providerId: string | null;
  model: string;
  prompt: string;
  jobId: string;
  createdAt: number;
}

export interface NewMessage {
  chatId: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  providerId?: string | null;
  model?: string | null;
}

export interface FinishedAnswer {
  content: string;
  reasoning: string | null;
  status: MessageStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  error: ProviderError | null;
}

export class ChatRepo {
  constructor(
    private readonly db: Database,
    private readonly media: MediaRepo,
  ) {}

  list(): ChatView[] {
    return (this.db.sql.prepare("select * from chats order by updated_at desc").all() as unknown as ChatRow[]).map(toChat);
  }

  get(id: string): ChatWithMessages | null {
    const row = this.chatRow(id);
    if (!row) return null;
    const messages = this.db.sql
      .prepare("select * from messages where chat_id = ? order by created_at, rowid")
      .all(id) as unknown as MessageRow[];
    const media = this.media.forMessages(messages.map((m) => m.id));
    return { ...toChat(row), messages: messages.map((m) => toMessage(m, media.get(m.id) ?? [])) };
  }

  create(providerId: string, model: string, kind: ChatKind = "text"): ChatView {
    const now = Date.now();
    const row = { id: randomUUID(), title: null, provider_id: providerId, model, kind, created_at: now, updated_at: now };
    this.db.sql
      .prepare(
        "insert into chats (id, title, provider_id, model, kind, created_at, updated_at) values (:id, :title, :provider_id, :model, :kind, :created_at, :updated_at)",
      )
      .run({ ...row });
    return toChat({ ...row, folder: null });
  }

  update(id: string, patch: ChatUpdate): ChatView | null {
    const row = this.chatRow(id);
    if (!row) return null;
    const next: ChatRow = {
      ...row,
      title: patch.title ?? row.title,
      provider_id: patch.providerId ?? row.provider_id,
      model: patch.model ?? row.model,
      kind: patch.kind ?? row.kind,
      updated_at: Date.now(),
    };
    this.db.sql
      .prepare(
        "update chats set title = :title, provider_id = :provider_id, model = :model, kind = :kind, updated_at = :updated_at where id = :id",
      )
      .run({ id, title: next.title, provider_id: next.provider_id, model: next.model, kind: next.kind, updated_at: next.updated_at });
    return toChat(next);
  }

  remove(id: string): boolean {
    return Number(this.db.sql.prepare("delete from chats where id = ?").run(id).changes) > 0;
  }

  setFolder(id: string, folder: string | null): ChatView | null {
    if (Number(this.db.sql.prepare("update chats set folder = ?, updated_at = ? where id = ?").run(folder, Date.now(), id).changes) === 0) return null;
    return toChat(this.chatRow(id)!);
  }

  /** The snapshot of the folder taken before an answer; null once there is nothing to undo. */
  checkpoint(messageId: string): string | null {
    return (this.db.sql.prepare("select checkpoint from messages where id = ?").get(messageId) as { checkpoint: string | null } | undefined)?.checkpoint ?? null;
  }

  setCheckpoint(messageId: string, commit: string | null): void {
    this.db.sql.prepare("update messages set checkpoint = ? where id = ?").run(commit, messageId);
  }

  /** Names a chat after its first message: first line, at most 60 characters. */
  nameIfUntitled(id: string, firstMessage: string): void {
    const line = firstMessage.trim().split("\n")[0]!.trim();
    const title = line.length > 60 ? `${line.slice(0, 60).replace(/\s+\S*$/, "")}…` : line;
    this.db.sql.prepare("update chats set title = ? where id = ? and title is null").run(title, id);
  }

  addMessage(m: NewMessage): MessageView {
    const row: MessageRow = {
      id: randomUUID(),
      chat_id: m.chatId,
      role: m.role,
      content: m.content,
      reasoning: null,
      provider_id: m.providerId ?? null,
      model: m.model ?? null,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      status: m.status,
      error_code: null,
      error_detail: null,
      created_at: Date.now(),
      media_job: null,
      checkpoint: null,
    };
    const cols = Object.keys(row);
    this.db.sql
      .prepare(`insert into messages (${cols.join(", ")}) values (${cols.map((c) => `:${c}`).join(", ")})`)
      .run({ ...row });
    this.db.sql.prepare("update chats set updated_at = ? where id = ?").run(row.created_at, m.chatId);
    return toMessage(row, []);
  }

  /** Remembers the provider's job for a clip, so waiting survives a restart. */
  setMediaJob(messageId: string, jobId: string | null): void {
    this.db.sql.prepare("update messages set media_job = ? where id = ?").run(jobId, messageId);
  }

  pendingJobs(): PendingJob[] {
    const rows = this.db.sql
      .prepare(
        `select a.id, a.chat_id, a.provider_id, a.model, a.media_job, a.created_at,
                (select u.content from messages u where u.chat_id = a.chat_id and u.role = 'user' and u.created_at <= a.created_at
                 order by u.created_at desc, u.rowid desc limit 1) as prompt
         from messages a where a.status = 'streaming' and a.media_job is not null`,
      )
      .all() as {
      id: string;
      chat_id: string;
      provider_id: string | null;
      model: string;
      media_job: string;
      created_at: number;
      prompt: string | null;
    }[];
    return rows.map((r) => ({
      messageId: r.id,
      chatId: r.chat_id,
      providerId: r.provider_id,
      model: r.model,
      prompt: r.prompt ?? "",
      jobId: r.media_job,
      createdAt: r.created_at,
    }));
  }

  finishAnswer(id: string, a: FinishedAnswer): MessageView {
    this.db.sql
      .prepare(
        `update messages set content = :content, reasoning = :reasoning, status = :status, input_tokens = :input_tokens,
         output_tokens = :output_tokens, cost_usd = :cost_usd, error_code = :error_code, error_detail = :error_detail
         where id = :id`,
      )
      .run({
        id,
        content: a.content,
        reasoning: a.reasoning,
        status: a.status,
        input_tokens: a.inputTokens,
        output_tokens: a.outputTokens,
        cost_usd: a.costUsd,
        error_code: a.error?.code ?? null,
        error_detail: a.error?.detail ?? null,
      });
    return this.message(id)!;
  }

  message(id: string): MessageView | null {
    const row = this.db.sql.prepare("select * from messages where id = ?").get(id) as unknown as MessageRow | undefined;
    return row ? toMessage(row, this.media.forMessages([id]).get(id) ?? []) : null;
  }

  /** The command-line agent's session this chat continues, as `storeSession` wrote it. */
  cliSession(chatId: string): string | null {
    const row = this.db.sql.prepare("select cli_session from chats where id = ?").get(chatId) as { cli_session: string | null } | undefined;
    return row?.cli_session ?? null;
  }

  setCliSession(chatId: string, session: string): void {
    this.db.sql.prepare("update chats set cli_session = ? where id = ?").run(session, chatId);
  }

  /** What the model sees: finished turns only. Failed and empty answers are left out. */
  history(chatId: string): { role: "user" | "assistant"; content: string }[] {
    const rows = this.db.sql
      .prepare(
        `select role, content from messages where chat_id = ?
         and (role = 'user' or (status in ('done', 'stopped') and content <> ''))
         order by created_at, rowid`,
      )
      .all(chatId) as { role: "user" | "assistant"; content: string }[];
    return rows.map(({ role, content }) => ({ role, content }));
  }

  usageSince(since: number): UsageSummary {
    const row = this.db.sql
      .prepare(
        `select coalesce(sum(i), 0) as input, coalesce(sum(o), 0) as output, coalesce(sum(c), 0) as cost, coalesce(sum(u), 0) as unpriced
         from (
           select input_tokens as i, output_tokens as o, cost_usd as c,
                  case when cost_usd is null and output_tokens is not null then 1 else 0 end as u
           from messages where role = 'assistant' and created_at >= ?
           union all
           select input_tokens, output_tokens, cost_usd, case when priced = 0 then 1 else 0 end
           from agent_usage where created_at >= ?
         )`,
      )
      .get(since, since) as { input: number; output: number; cost: number; unpriced: number | null };
    return { inputTokens: row.input, outputTokens: row.output, costUsd: row.cost, unpricedMessages: row.unpriced ?? 0 };
  }

  private chatRow(id: string): ChatRow | undefined {
    return this.db.sql.prepare("select * from chats where id = ?").get(id) as ChatRow | undefined;
  }
}

function toChat(r: ChatRow): ChatView {
  return {
    id: r.id,
    title: r.title,
    providerId: r.provider_id,
    model: r.model,
    kind: r.kind,
    folder: r.folder ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toMessage(r: MessageRow, media: MessageView["media"]): MessageView {
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    reasoning: r.reasoning,
    providerId: r.provider_id,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    status: r.status,
    error: r.error_code ? ({ code: r.error_code, ...(r.error_detail ? { detail: r.error_detail } : {}) } as ProviderError) : null,
    media,
    canUndo: !!r.checkpoint,
    createdAt: r.created_at,
  };
}
