import type { TaskEvent } from "@drimvox/shared";

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
  | { kind: "approval"; seq: number; id: string; command: string; reason: string; allowed: boolean | null; always: boolean }
  | { kind: "status"; seq: number; status: string; reason: string | null; detail: string | null }
  | { kind: "phase"; seq: number; phase: string; round: number | null }
  | { kind: "acceptance"; seq: number; round: number; done: number; total: number; summary: string }
  | { kind: "milestone"; seq: number; stage: number; total: number; title: string }
  | { kind: "reference"; seq: number; url: string | null; shot: string | null; description: string | null }
  | { kind: "design"; seq: number; verdict: "good" | "polish"; issues: number }
  | { kind: "questions"; seq: number; questions: { id: string; question: string }[] }
  | { kind: "answers"; seq: number; answers: { id: string; answer: string }[]; skipped: boolean }
  | { kind: "spec"; seq: number; spec: string; checks: string[]; edited: boolean }
  | { kind: "check"; seq: number; phase: string; command: string; exitCode: number | null; ok: boolean; output: string }
  | { kind: "escalation"; seq: number; from: string; to: string }
  | { kind: "screenshot"; seq: number; id: string; url: string }
  | { kind: "plan"; seq: number; spec: string; checks: string[]; subtasks: { id: string; title: string }[]; edited: boolean }
  | { kind: "subtask"; seq: number; id: string; taskId: string | null; title: string; action: string; files: string[] };

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
        // finish is shown as the task summary; questions and the spec have lines of their own.
        if (["finish", "ask_questions", "propose_spec", "propose_plan", "answer"].includes(d.name)) break;
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
        if (known) {
          known.allowed = d.allowed;
          known.always = !!d.always;
        } else {
          const item = { kind: "approval" as const, seq: e.seq, id: d.id, command: d.command, reason: d.reason, allowed: d.allowed, always: !!d.always };
          approvals.set(d.id, item);
          items.push(item);
        }
        break;
      }
      case "status":
        items.push({ kind: "status", seq: e.seq, status: d.status, reason: d.reason ?? null, detail: d.detail ?? null });
        break;
      case "phase":
        items.push({ kind: "phase", seq: e.seq, phase: d.phase, round: typeof d.round === "number" ? d.round : null });
        break;
      case "milestone":
        items.push({ kind: "milestone", seq: e.seq, stage: Number(d.stage ?? 1), total: Number(d.total ?? 1), title: String(d.title ?? "") });
        break;
      case "reference":
        items.push({ kind: "reference", seq: e.seq, url: d.url ?? null, shot: d.shot ?? null, description: d.description ?? null });
        break;
      case "design_review":
        items.push({ kind: "design", seq: e.seq, verdict: d.verdict === "polish" ? "polish" : "good", issues: (d.issues ?? []).length });
        break;
      case "acceptance":
        items.push({
          kind: "acceptance",
          seq: e.seq,
          round: Number(d.round ?? 1),
          done: (d.results ?? []).filter((r: { status: string }) => r.status === "done").length,
          total: (d.results ?? []).length,
          summary: String(d.summary ?? ""),
        });
        break;
      case "questions":
        items.push({ kind: "questions", seq: e.seq, questions: d.questions ?? [] });
        break;
      case "answers":
        items.push({ kind: "answers", seq: e.seq, answers: d.answers ?? [], skipped: !!d.skipped });
        break;
      case "spec":
        items.push({ kind: "spec", seq: e.seq, spec: d.spec ?? "", checks: d.checks ?? [], edited: !!d.edited });
        break;
      case "check":
        items.push({ kind: "check", seq: e.seq, phase: d.phase, command: d.command, exitCode: d.exitCode ?? null, ok: !!d.ok, output: d.output ?? "" });
        break;
      case "screenshot":
        items.push({ kind: "screenshot", seq: e.seq, id: String(d.id), url: String(d.url ?? "") });
        break;
      case "escalation":
        items.push({ kind: "escalation", seq: e.seq, from: d.from, to: d.to });
        break;
      case "plan":
        items.push({ kind: "plan", seq: e.seq, spec: d.spec ?? "", checks: d.checks ?? [], subtasks: d.subtasks ?? [], edited: !!d.edited });
        break;
      case "subtask":
        items.push({ kind: "subtask", seq: e.seq, id: d.id, taskId: d.taskId ?? null, title: d.title ?? d.id, action: d.action, files: d.files ?? [] });
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
