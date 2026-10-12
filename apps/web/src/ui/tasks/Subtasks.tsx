import type { TaskView } from "@artel/shared";
import { useApp } from "../../context";
import { formatUsd } from "../../lib/format";
import { StatusChip } from "./StatusDot";

/** The team's subtasks in plan order: who is working, who waits for whom, what is merged. */
export function SubtaskBoard({ task }: { task: TaskView }) {
  const { t, navigate } = useApp();
  const titles = new Map(task.subtasks.map((s) => [s.id, s.title]));
  return (
    <section className="subtasks">
      <h2 className="sheet-h">{t("team.subtasks")}</h2>
      <ol className="subtask-board">
        {task.subtasks.map((s) => {
          const waitsFor = s.status === "queued" ? s.dependsOn.map((d) => titles.get(d) ?? d) : [];
          return (
            <li key={s.taskId}>
              <button className={`subtask-card is-${s.status}`} onClick={() => navigate({ kind: "task", taskId: s.taskId })}>
                <span className="subtask-title">{s.title}</span>
                <StatusChip status={s.status} />
                <span className="subtask-meta muted">
                  <span className="mono">{s.model}</span>
                  {s.costUsd > 0 && <span className="mono">{formatUsd(s.costUsd)}</span>}
                  {waitsFor.length > 0 && <span>{t("plan.after", { list: waitsFor.join(", ") })}</span>}
                  {s.status === "waiting" && s.statusReason === "approval" && <span className="is-wait-text">{t("team.asks")}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** On a subtask's sheet: the way back to the goal it belongs to. */
export function GoalLink({ task }: { task: TaskView }) {
  const { t, navigate, tasks } = useApp();
  if (!task.parentId) return null;
  const goal = tasks.find((g) => g.id === task.parentId);
  return (
    <button className="link goal-link" onClick={() => navigate({ kind: "task", taskId: task.parentId! })}>
      {t("team.backToGoal", { title: goal?.title ?? "" })}
    </button>
  );
}
