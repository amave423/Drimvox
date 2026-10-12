import type { TaskView } from "@artel/shared";

export type NoticeKind = "review" | "answered" | "waiting" | "stuck" | "failed";

export interface Notice {
  taskId: string;
  title: string;
  kind: NoticeKind;
}

const STUCK = new Set(["stuck", "subtask_stuck", "integration_red", "visual_failed"]);

function kindOf(t: TaskView): NoticeKind | null {
  if (t.status === "review" || (t.status === "done_empty" && t.statusReason !== "answered")) return "review";
  if (t.status === "done_empty") return "answered";
  if (t.status === "failed") return "failed";
  if (t.status === "waiting") return STUCK.has(t.statusReason ?? "") ? "stuck" : "waiting";
  return null;
}

/**
 * What deserves a Windows notification between two looks at the task list: a task that now needs the user.
 * Nothing on the first look (`before` is null), when the app has just opened.
 */
export function noticesFor(before: TaskView[] | null, after: TaskView[]): Notice[] {
  if (!before) return [];
  const was = new Map(before.map((t) => [t.id, `${t.status}:${t.statusReason ?? ""}`]));
  const notices: Notice[] = [];
  for (const t of after) {
    const kind = kindOf(t);
    if (!kind || was.get(t.id) === `${t.status}:${t.statusReason ?? ""}`) continue;
    notices.push({ taskId: t.id, title: t.title, kind });
  }
  return notices;
}
