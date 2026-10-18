import type { AttachmentView } from "@artel/shared";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db";
import type { AttachmentKind } from "./attachments";

interface Row {
  id: string;
  chat_id: string;
  message_id: string | null;
  name: string;
  type: string;
  size: number;
  kind: AttachmentKind;
  text: string | null;
  created_at: number;
}

const toView = (r: Row): AttachmentView => ({ id: r.id, name: r.name, type: r.type, size: r.size, kind: r.kind });

/** Files attached to chat messages: kept in the data folder, with what was read out of them. */
export class AttachmentRepo {
  readonly dir: string;

  constructor(
    private readonly db: Database,
    dataDir: string,
  ) {
    this.dir = join(dataDir, "attachments");
  }

  add(chatId: string, a: { name: string; type: string; data: Buffer; kind: AttachmentKind; text: string | null }): AttachmentView {
    mkdirSync(this.dir, { recursive: true });
    const row: Row = { id: randomUUID(), chat_id: chatId, message_id: null, name: a.name, type: a.type, size: a.data.length, kind: a.kind, text: a.text, created_at: Date.now() };
    writeFileSync(join(this.dir, row.id), a.data);
    this.db.sql
      .prepare("insert into attachments (id, chat_id, message_id, name, type, size, kind, text, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.chat_id, null, row.name, row.type, row.size, row.kind, row.text, row.created_at);
    return toView(row);
  }

  get(id: string): (AttachmentView & { chatId: string; text: string | null }) | null {
    const row = this.db.sql.prepare("select * from attachments where id = ?").get(id) as Row | undefined;
    return row ? { ...toView(row), chatId: row.chat_id, text: row.text } : null;
  }

  file(id: string): Buffer {
    return readFileSync(join(this.dir, id));
  }

  /** Ties uploaded files to the message they were sent with; only the chat's own, not yet sent ones. */
  attach(chatId: string, messageId: string, ids: string[]): void {
    const set = this.db.sql.prepare("update attachments set message_id = ? where id = ? and chat_id = ? and message_id is null");
    for (const id of ids) set.run(messageId, id, chatId);
  }

  forMessages(messageIds: string[]): Map<string, (AttachmentView & { text: string | null })[]> {
    const map = new Map<string, (AttachmentView & { text: string | null })[]>();
    if (messageIds.length === 0) return map;
    const rows = this.db.sql
      .prepare(`select * from attachments where message_id in (${messageIds.map(() => "?").join(", ")}) order by created_at, rowid`)
      .all(...messageIds) as unknown as Row[];
    for (const r of rows) map.set(r.message_id!, [...(map.get(r.message_id!) ?? []), { ...toView(r), text: r.text }]);
    return map;
  }

  /** Every file sent in the chat, by name: what save_attachment can put into the chat's folder. */
  ofChat(chatId: string): AttachmentView[] {
    return (this.db.sql.prepare("select * from attachments where chat_id = ? and message_id is not null order by created_at").all(chatId) as unknown as Row[]).map(toView);
  }
}
