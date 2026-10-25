import type { WorkReport } from "@drimvox/shared";
import { folderChanges } from "./changes";
import type { ProjectWorkRepo } from "./repo";

/**
 * The report after a project's work (asked for): how long it took, what it cost on each model, what the agent spent its
 * actions on, how much of the folder changed and how much of the checklist is done.
 */
export async function workReport(repo: ProjectWorkRepo, projectId: string, folder: string): Promise<WorkReport | null> {
  const row = repo.get(projectId);
  if (!row?.chatId || !row.startedAt) return null;
  const answers = repo.answers(row.chatId, row.startedAt);
  const byModel = new Map<string, { answers: number; costUsd: number }>();
  const actions = new Map<string, number>();
  for (const a of answers) {
    const m = byModel.get(a.model ?? "?") ?? { answers: 0, costUsd: 0 };
    byModel.set(a.model ?? "?", { answers: m.answers + 1, costUsd: m.costUsd + a.costUsd });
    for (const name of a.actions) actions.set(name, (actions.get(name) ?? 0) + 1);
  }
  const files = await folderChanges(folder).catch(() => []);
  return {
    workedMs: row.workedMs,
    costUsd: answers.reduce((s, a) => s + a.costUsd, 0),
    inputTokens: answers.reduce((s, a) => s + a.inputTokens, 0),
    outputTokens: answers.reduce((s, a) => s + a.outputTokens, 0),
    byModel: [...byModel].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.costUsd - a.costUsd),
    actions: [...actions].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    files: { changed: files.length, added: files.reduce((s, f) => s + f.added, 0), removed: files.reduce((s, f) => s + f.removed, 0) },
    checklist: { done: row.checklist.filter((i) => i.done).length, total: row.checklist.length },
  };
}
