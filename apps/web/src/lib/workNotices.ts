import type { ProjectWorkView } from "@drimvox/shared";

export type WorkNoticeKind = "approval" | "done" | "paused";

export interface WorkNotice {
  projectId: string;
  /** Where the notification leads: the plan's task links to the project's conversation. */
  taskId: string | null;
  kind: WorkNoticeKind;
}

function kindOf(w: ProjectWorkView): WorkNoticeKind | null {
  if (w.status === "running") return w.waitingApproval ? "approval" : null;
  if (w.status === "done") return "done";
  if (w.status === "paused") return "paused";
  return null;
}

/**
 * What deserves a Windows notification between two looks at the projects' work (docs/specs/project-work.md): a run that
 * waits for a permission, is done, or stopped on a limit. Nothing on the first look, when the app has just opened.
 */
export function workNotices(before: ProjectWorkView[] | null, after: ProjectWorkView[]): WorkNotice[] {
  if (!before) return [];
  const was = new Map(before.map((w) => [w.projectId, kindOf(w)]));
  return after.flatMap((w) => {
    const kind = kindOf(w);
    return kind && was.get(w.projectId) !== kind ? [{ projectId: w.projectId, taskId: w.planTaskId, kind }] : [];
  });
}
