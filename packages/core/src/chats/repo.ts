import type { AttachmentView, ChatKind, ChatUpdate, ChatView, ChatWithMessages, MessageStatus, MessageView, ProviderError, UsageSummary } from "@artel/shared";
import { randomUUID } from "node:crypto";
import type { Database } from "../db";
import type { MediaRepo } from "../media/repo";
import type { AttachmentRepo } from "./attachment-repo";

interface ChatRow {
  id: string;
  title: string | null;
  provider_id: string | null;
  model: string | null;
  kind: ChatKind;
  folder: string | null;
  project_id: string | null;
  item_id: string | null;
  created_at: number;
  updated_at: number;
  /** Only in the list: an answer is being written, and one came after the chat was last looked at. */
  answering?: number;
  unread?: number;
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
  activity: string | null;
}

/** A clip the provider is still rendering for an answer. */
/** One turn of the conversation as the model gets it. */
export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
  attachments?: (AttachmentView & { text: string | null })[];
}

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
  /** The tools called while answering. */
  activity?: { name: string; input: string }[];
}

export class ChatRepo {
  constructor(
    private readonly db: Database,
    private readonly media: MediaRepo,
    readonly attachments: AttachmentRepo,
  ) {}

  list(): ChatView[] {
    // A spinner while an answer is written, a dot for one that came after the chat was last looked at.
    const rows = this.db.sql
      .prepare(
        `select c.*,
           exists(select 1 from messages m where m.chat_id = c.id and m.status = 'streaming') as answering,
           coalesce((select max(m.created_at) from messages m where m.chat_id = c.id and m.role = 'assistant' and m.status != 'streaming'), 0) > coalesce(c.seen_at, 0) as unread
         from chats c order by c.updated_at desc`,
      )
      .all() as unknown as ChatRow[];
    return rows.map(toChat);
  }

  /** The user looked at the chat: its answers so far are read. */
  markSeen(id: string): boolean {
    return Number(this.db.sql.prepare("update chats set seen_at = ? where id = ?").run(Date.now(), id).changes) > 0;
  }

  /** The chat and its messages; the requests its answer waits on live in the core, not here (routes add them). */
  get(id: string): Omit<ChatWithMessages, "approvals"> | null {
    const row = this.chatRow(id);
    if (!row) return null;
    const messages = this.db.sql
      .prepare("select * from messages where chat_id = ? order by created_at, rowid")
      .all(id) as unknown as MessageRow[];
    const media = this.media.forMessages(messages.map((m) => m.id));
    const files = this.attachments.forMessages(messages.map((m) => m.id));
    return { ...toChat(row), messages: messages.map((m) => toMessage(m, media.get(m.id) ?? [], files.get(m.id) ?? [])) };
  }

  /** A new chat; `work` makes it a project task's conversation in the project's folder. */
  create(providerId: string, model: string, kind: ChatKind = "text", work?: { folder: string; projectId: string; itemId: string | null; title: string }): ChatView {
    const now = Date.now();
    const row = {
      id: randomUUID(),
      title: work?.title ?? null,
      provider_id: providerId,
      model,
      kind,
      folder: work?.folder ?? null,
      project_id: work?.projectId ?? null,
      item_id: work?.itemId ?? null,
      created_at: now,
      updated_at: now,
    };
    this.db.sql
      .prepare(
        "insert into chats (id, title, provider_id, model, kind, folder, project_id, item_id, created_at, updated_at) values (:id, :title, :provider_id, :model, :kind, :folder, :project_id, :item_id, :created_at, :updated_at)",
      )
      .run({ ...row });
    return toChat(row);
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
      activity: null,
    };
    const cols = Object.keys(row);
    this.db.sql
      .prepare(`insert into messages (${cols.join(", ")}) values (${cols.map((c) => `:${c}`).join(", ")})`)
      .run({ ...row });
    this.db.sql.prepare("update chats set updated_at = ? where id = ?").run(row.created_at, m.chatId);
    return toMessage(row, [], []);
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

  /** What an answer being written has so far; it stays "streaming". */
  saveProgress(id: string, p: { content: string; reasoning: string | null; activity: { name: string; input: string }[] }): void {
    this.db.sql
      .prepare("update messages set content = ?, reasoning = ?, activity = ? where id = ? and status = 'streaming'")
      .run(p.content, p.reasoning, p.activity.length ? JSON.stringify(p.activity) : null, id);
  }

  finishAnswer(id: string, a: FinishedAnswer): MessageView {
    this.db.sql
      .prepare(
        `update messages set content = :content, reasoning = :reasoning, status = :status, input_tokens = :input_tokens,
         output_tokens = :output_tokens, cost_usd = :cost_usd, error_code = :error_code, error_detail = :error_detail,
         activity = :activity
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
        activity: a.activity?.length ? JSON.stringify(a.activity) : null,
      });
    return this.message(id)!;
  }

  message(id: string): MessageView | null {
    const row = this.db.sql.prepare("select * from messages where id = ?").get(id) as unknown as MessageRow | undefined;
    return row ? toMessage(row, this.media.forMessages([id]).get(id) ?? [], this.attachments.forMessages([id]).get(id) ?? []) : null;
  }

  /** The command-line agent's session this chat continues, as `storeSession` wrote it. */
  cliSession(chatId: string): string | null {
    const row = this.db.sql.prepare("select cli_session from chats where id = ?").get(chatId) as { cli_session: string | null } | undefined;
    return row?.cli_session ?? null;
  }

  setCliSession(chatId: string, session: string): void {
    this.db.sql.prepare("update chats set cli_session = ? where id = ?").run(session, chatId);
  }

  /** What the model sees: finished turns only, with the user's attachments. Failed and empty answers are left out. */
  history(chatId: string): HistoryTurn[] {
    const rows = this.db.sql
      .prepare(
        `select id, role, content from messages where chat_id = ?
         and (role = 'user' or (status in ('done', 'stopped') and content <> ''))
         order by created_at, rowid`,
      )
      .all(chatId) as { id: string; role: "user" | "assistant"; content: string }[];
    const files = this.attachments.forMessages(rows.filter((r) => r.role === "user").map((r) => r.id));
    return rows.map(({ id, role, content }) => (files.has(id) ? { role, content, attachments: files.get(id)! } : { role, content }));
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
    projectId: r.project_id ?? null,
    itemId: r.item_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    answering: !!r.answering,
    unread: !!r.unread && !r.answering,
  };
}

function toMessage(r: MessageRow, media: MessageView["media"], attachments: MessageView["attachments"]): MessageView {
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
    attachments: attachments.map(({ id, name, type, size, kind }) => ({ id, name, type, size, kind })),
    activity: r.activity ? (JSON.parse(r.activity) as MessageView["activity"]) : [],
    createdAt: r.created_at,
  };
}
