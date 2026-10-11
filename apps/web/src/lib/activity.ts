import type { TaskEvent } from "@artel/shared";

export type FeedItem =
  | { kind: "user"; seq: number; text: string }
  | { kind: "note"; seq: number; text: string }
  | {
      kind: "action";
      seq: number;
      callId: string;
      name: string;
      input: Record<string, unknown>;
      result: { ok: boolean; output: string } | null;
    }
  | { kind: "approval"; seq: number; id: string; command: string; reason: string; allowed: boolean | null }
  | { kind: "status"; seq: number; status: string; reason: string | null; detail: string | null };

/** Folds the task's event log into feed lines: a tool call and its result become one line. */
export function buildFeed(events: TaskEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  const actions = new Map<string, Extract<FeedItem, { kind: "action" }>>();
  const approvals = new Map<string, Extract<FeedItem, { kind: "approval" }>>();

  for (const e of events) {
    const d = e.data ?? {};
    switch (e.kind) {
      case "user":
        items.push({ kind: "user", seq: e.seq, text: String(d.text ?? "") });
        break;
      case "text":
        items.push({ kind: "note", seq: e.seq, text: String(d.text ?? "") });
        break;
      case "tool_call": {
        // finish is shown as the task summary, not as an action.
        if (d.name === "finish") break;
        const item = { kind: "action" as const, seq: e.seq, callId: d.callId, name: d.name, input: d.input ?? {}, result: null };
        actions.set(d.callId, item);
        items.push(item);
        break;
      }
      case "tool_result": {
        const item = actions.get(d.callId);
        if (item) item.result = { ok: !!d.ok, output: String(d.output ?? "") };
        break;
      }
      case "approval": {
        const known = approvals.get(d.id);
        if (known) known.allowed = d.allowed;
        else {
          const item = { kind: "approval" as const, seq: e.seq, id: d.id, command: d.command, reason: d.reason, allowed: d.allowed };
          approvals.set(d.id, item);
          items.push(item);
        }
        break;
      }
      case "status":
        items.push({ kind: "status", seq: e.seq, status: d.status, reason: d.reason ?? null, detail: d.detail ?? null });
        break;
    }
  }
  return items;
}

/** Exit code the agent's command ended with, read from the tool output. */
export function exitCodeOf(output: string): number | null {
  const m = output.match(/^Exit code: (-?\d+)/);
  return m ? Number(m[1]) : null;
}
