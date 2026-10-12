import type { MediaItem, MediaKind } from "@artel/shared";
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db";

interface MediaRow {
  id: string;
  kind: MediaKind;
  mime: string;
  file: string;
  prompt: string;
  provider_id: string | null;
  model: string;
  cost_usd: number | null;
  chat_id: string | null;
  message_id: string | null;
  task_id: string | null;
  path: string | null;
  created_at: number;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export interface NewMedia {
  kind: MediaKind;
  mime: string;
  bytes: Buffer;
  prompt: string;
  providerId: string | null;
  model: string;
  costUsd: number | null;
  chatId?: string;
  messageId?: string;
  taskId?: string;
  path?: string;
}

/** Pictures and clips: a row in the database and a file in `<data>/media`. */
export class MediaRepo {
  readonly dir: string;

  constructor(
    private readonly db: Database,
    dataDir: string,
  ) {
    this.dir = join(dataDir, "media");
  }

  add(m: NewMedia): MediaItem {
    mkdirSync(this.dir, { recursive: true });
    const id = randomUUID();
    const file = `${id}.${EXT[m.mime] ?? "bin"}`;
    writeFileSync(join(this.dir, file), m.bytes);
    const row: MediaRow = {
      id,
      kind: m.kind,
      mime: m.mime,
      file,
      prompt: m.prompt,
      provider_id: m.providerId,
      model: m.model,
      cost_usd: m.costUsd,
      chat_id: m.chatId ?? null,
      message_id: m.messageId ?? null,
      task_id: m.taskId ?? null,
      path: m.path ?? null,
      created_at: Date.now(),
    };
    const cols = Object.keys(row);
    this.db.sql
      .prepare(`insert into media (${cols.join(", ")}) values (${cols.map((c) => `:${c}`).join(", ")})`)
      .run(row as unknown as Record<string, string | number | null>);
    return toItem(row);
  }

  list(): MediaItem[] {
    return (this.db.sql.prepare("select * from media order by created_at desc, rowid desc").all() as unknown as MediaRow[]).map(toItem);
  }

  forMessages(ids: string[]): Map<string, MediaItem[]> {
    const out = new Map<string, MediaItem[]>();
    if (ids.length === 0) return out;
    const rows = this.db.sql
      .prepare(`select * from media where message_id in (${ids.map(() => "?").join(", ")}) order by created_at, rowid`)
      .all(...ids) as unknown as MediaRow[];
    for (const row of rows) out.set(row.message_id!, [...(out.get(row.message_id!) ?? []), toItem(row)]);
    return out;
  }

  /** The file on disk and its type, for serving. */
  file(id: string): { path: string; mime: string } | null {
    const row = this.db.sql.prepare("select file, mime from media where id = ?").get(id) as { file: string; mime: string } | undefined;
    return row ? { path: join(this.dir, row.file), mime: row.mime } : null;
  }

  remove(id: string): boolean {
    const found = this.file(id);
    if (!found) return false;
    this.db.sql.prepare("delete from media where id = ?").run(id);
    // unlinkSync, not rmSync: on Node 24.11 rmSync silently keeps files under non-ASCII paths, such as a Cyrillic user folder.
    try {
      unlinkSync(found.path);
    } catch {
      // Already gone.
    }
    return true;
  }
}

function toItem(r: MediaRow): MediaItem {
  return {
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    prompt: r.prompt,
    providerId: r.provider_id,
    model: r.model,
    costUsd: r.cost_usd,
    chatId: r.chat_id,
    taskId: r.task_id,
    path: r.path,
    createdAt: r.created_at,
  };
}
