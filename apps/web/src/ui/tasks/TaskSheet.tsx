import type { TaskView } from "@artel/shared";
import { useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { buildFeed, type FeedItem } from "../../lib/activity";
import { formatBudget, formatTokens, formatUsd } from "../../lib/format";
import { ErrorNote } from "../ErrorNote";
import type { LineComment } from "./DiffView";
import { Feed } from "./Feed";
import { Review } from "./Review";
import { StatusChip } from "./StatusDot";
import { useTaskStream } from "./useTaskStream";

const REVIEW_STATES = new Set(["review", "done_empty", "accepted", "discarded"]);

export function TaskSheet({ taskId }: { taskId: string }) {
  const { api, t, settings } = useApp();
  const { task, events } = useTaskStream(taskId);
  const [comments, setComments] = useState<LineComment[]>([]);

  if (!task) return <article className="sheet" aria-busy />;
  const feed = buildFeed(events);
  const reviewing = REVIEW_STATES.has(task.status);

  const answer = (approvalId: string, allow: boolean) =>
    void api.tasks[":id"].approvals[":approvalId"].$post({ param: { id: task.id, approvalId }, json: { allow } }).catch(() => null);

  return (
    <article className="sheet task">
      <div className="sheet-body">
        <header className="task-head">
          <h1>{task.title}</h1>
          <div className="facts">
            <StatusChip status={task.status} />
            <span className="mono muted">{task.model}</span>
          </div>
        </header>

        <TaskNotice task={task} feed={feed} />

        {reviewing ? (
          <>
            <Review task={task} comments={comments} setComments={setComments} />
            <details className="worked">
              <summary>{t("review.howWorked")}</summary>
              <Feed items={feed} />
            </details>
          </>
        ) : (
          <>
            <h2 className="sheet-h">{t("task.feed")}</h2>
            <Feed items={feed} onAnswer={task.pendingApproval ? answer : undefined} />
          </>
        )}
      </div>

      <aside className="margin">
        <p className="note">
          {task.costUsd === 0 && task.steps > 0
            ? t("task.free")
            : t("task.spent", { cost: formatUsd(task.costUsd), budget: formatBudget(task.budgetUsd) })}
          <br />
          {t("task.tokens", { tokens: formatTokens(task.inputTokens + task.outputTokens, settings.locale), steps: task.steps })}
        </p>
        <p className="note">
          {t("task.branch")}
          <br />
          <span className="mono">{task.branch}</span>
        </p>
        {comments.length > 0 && (
          <div className="note is-pencil">
            <strong>{t("review.comments")}</strong>
            {comments.map((c, i) => (
              <p key={i} className="margin-comment">
                <span className="mono">
                  {c.path}:{c.line}
                  {c.side === "old" && ` (${t("review.removedLine")})`}
                </span>
                <em>{c.text}</em>
                <button className="link" onClick={() => setComments(comments.filter((_, j) => j !== i))}>
                  {t("review.removeComment")}
                </button>
              </p>
            ))}
          </div>
        )}
      </aside>
    </article>
  );
}

/** What the task waits for and the one action that moves it on. */
function TaskNotice({ task, feed }: { task: TaskView; feed: FeedItem[] }) {
  const { api, t, settings } = useApp();
  const stop = () => void api.tasks[":id"].stop.$post({ param: { id: task.id } }).catch(() => null);
  const carryOn = () => void api.tasks[":id"].continue.$post({ param: { id: task.id }, json: {} }).catch(() => null);

  if (task.status === "running" || (task.status === "waiting" && task.statusReason === "approval")) {
    const waiting = task.status === "waiting";
    return (
      <div className={`task-notice${waiting ? " is-wait" : ""}`}>
        {!waiting && <span className="action-spinner" aria-hidden />}
        <p>{t(waiting ? "task.waitingApproval" : "task.working")}</p>
        <button className="btn is-pencil" onClick={stop}>
          {t("task.stop")}
        </button>
      </div>
    );
  }

  if (task.status === "waiting" || task.status === "stopped") {
    const key = `task.reason.${task.statusReason ?? "user"}` as MessageKey;
    return (
      <div className="task-notice is-wait">
        <p>{t(key, { budget: formatBudget(settings.agentBudgetUsd) })}</p>
        <button className="btn is-primary" onClick={carryOn}>
          {t("task.continue")}
        </button>
      </div>
    );
  }

  if (task.status === "failed") {
    const detail = [...feed].reverse().find((i): i is Extract<FeedItem, { kind: "status" }> => i.kind === "status")?.detail;
    return (
      <div className="task-notice is-failed">
        {task.statusReason === "no_provider" ? (
          <p className="error-note">{t("task.reason.no_provider")}</p>
        ) : (
          <ErrorNote error={{ code: task.statusReason ?? "unknown", detail: detail ?? undefined }} />
        )}
        <button className="btn" onClick={carryOn}>
          {t("task.retry")}
        </button>
      </div>
    );
  }
  return null;
}
