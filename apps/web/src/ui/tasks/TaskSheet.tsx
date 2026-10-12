import type { TaskView } from "@artel/shared";
import { useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { buildFeed, type FeedItem } from "../../lib/activity";
import { formatBudget, formatTokens, formatUsd } from "../../lib/format";
import { dictionaries } from "../../i18n";
import { ErrorNote } from "../ErrorNote";
import type { LineComment } from "./DiffView";
import { Feed } from "./Feed";
import { Answer } from "./Answer";
import { Interview } from "./Interview";
import { PlanReview } from "./PlanReview";
import { Review } from "./Review";
import { SpecReview } from "./SpecReview";
import { PhaseSteps } from "./Stages";
import { StatusChip } from "./StatusDot";
import { GoalLink, SubtaskBoard } from "./Subtasks";
import { useTaskStream } from "./useTaskStream";

const REVIEW_STATES = new Set(["review", "done_empty", "accepted", "discarded"]);
/** Waiting states with their own controls below the notice. */
const ANSWERED_BELOW = new Set(["questions", "spec_review", "plan_review"]);
/** Waiting states whose last status line explains what went wrong. */
const WITH_DETAIL = new Set(["stuck", "integration_red", "subtask_stuck"]);

export function TaskSheet({ taskId }: { taskId: string }) {
  const { api, t, settings } = useApp();
  const { task, events } = useTaskStream(taskId);
  const [comments, setComments] = useState<LineComment[]>([]);

  if (!task) return <article className="sheet" aria-busy />;
  // A subtask's brief is written for the model; the user sees what the subtask is about instead.
  const feed = buildFeed(events).map((item) =>
    task.kind === "subtask" && item.kind === "user" && item.text.includes("Subtask id: ") ? { ...item, text: task.task } : item,
  );
  const stuck = task.status === "waiting" && task.statusReason === "stuck";
  // A subtask is never reviewed on its own: the goal merges it and the user reviews the goal.
  const answered = task.status === "done_empty" && task.statusReason === "answered";
  const reviewing = task.kind !== "subtask" && !answered && (REVIEW_STATES.has(task.status) || stuck);
  const waitingFor = task.status === "waiting" ? task.statusReason : null;

  const answer = (approvalId: string, allow: boolean, always = false) =>
    void api.tasks[":id"].approvals[":approvalId"].$post({ param: { id: task.id, approvalId }, json: { allow, always } }).catch(() => null);

  return (
    <article className="sheet task">
      <div className="sheet-body">
        <header className="task-head">
          <GoalLink task={task} />
          <h1>{task.title}</h1>
          <div className="facts">
            <StatusChip status={task.status} />
            <span className="mono muted">{task.model}</span>
            {task.team && <span className="muted">{t("team.workers", { model: task.team.model })}</span>}
          </div>
          {!answered && <PhaseSteps task={task} />}
        </header>

        <TaskNotice task={task} feed={feed} />
        {waitingFor === "questions" && <Interview key={task.updatedAt} task={task} />}
        {waitingFor === "spec_review" && <SpecReview key={task.spec ?? ""} task={task} />}
        {waitingFor === "plan_review" && <PlanReview key={task.updatedAt} task={task} />}
        {task.subtasks.length > 0 && <SubtaskBoard task={task} />}

        {answered && <Answer task={task} />}
        {answered ? (
          <details className="worked">
            <summary>{t("answer.howFound")}</summary>
            <Feed items={feed} />
          </details>
        ) : reviewing ? (
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
        {task.status !== "merged" && task.status !== "queued" && (
          <p className="note">
            {t("task.branch")}
            <br />
            <span className="mono">{task.branch}</span>
          </p>
        )}
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
  const drop = () => void api.tasks[":id"].drop.$post({ param: { id: task.id } }).catch(() => null);
  // A subtask that cannot go on can leave the goal; the rest of the team carries on without it.
  const dropButton = task.kind === "subtask" && (
    <button className="btn is-pencil" onClick={drop}>
      {t("team.drop")}
    </button>
  );

  const asking = task.status === "waiting" && (task.statusReason === "approval" || task.statusReason === "subtask_waiting");
  if (task.status === "running" || asking) {
    const working = task.kind === "goal" && task.phase === "orchestrate" ? "team.working" : "task.working";
    return (
      <div className={`task-notice${asking ? " is-wait" : ""}`}>
        {!asking && <span className="action-spinner" aria-hidden />}
        <p>{t(asking ? (task.statusReason === "approval" ? "task.waitingApproval" : "team.subtaskAsks") : working)}</p>
        <button className="btn is-pencil" onClick={stop}>
          {t("task.stop")}
        </button>
      </div>
    );
  }

  if (task.status === "queued" || task.status === "merged") {
    return (
      <div className="task-notice">
        <p>{t(task.status === "queued" ? "team.queued" : "team.merged")}</p>
      </div>
    );
  }

  // Interview answers, spec and plan approval have their own controls below the notice.
  if (task.status === "waiting" && ANSWERED_BELOW.has(task.statusReason ?? "")) {
    return (
      <div className="task-notice is-wait">
        <p>{t(`task.reason.${task.statusReason}` as MessageKey)}</p>
      </div>
    );
  }

  if (task.status === "waiting" || task.status === "stopped") {
    const key = (task.kind === "subtask" && task.statusReason === "stuck" ? "team.stuck" : `task.reason.${task.statusReason ?? "user"}`) as MessageKey;
    const detail = WITH_DETAIL.has(task.statusReason ?? "") ? lastStatusDetail(feed) : null;
    return (
      <div className="task-notice is-wait">
        <p>{t(key, { budget: formatBudget(settings.agentBudgetUsd) })}</p>
        <button className="btn is-primary" onClick={carryOn}>
          {t("task.continue")}
        </button>
        {dropButton}
        {detail && <pre className="action-output mono stuck-report">{detail}</pre>}
      </div>
    );
  }

  if (task.status === "failed") {
    const detail = lastStatusDetail(feed);
    const own = `task.reason.${task.statusReason}`;
    return (
      <div className="task-notice is-failed">
        {own in dictionaries.ru ? (
          <p className="error-note">{t(own as MessageKey)}</p>
        ) : (
          <ErrorNote error={{ code: task.statusReason ?? "unknown", detail: detail ?? undefined }} />
        )}
        <button className="btn" onClick={carryOn}>
          {t("task.retry")}
        </button>
        {dropButton}
      </div>
    );
  }
  return null;
}

function lastStatusDetail(feed: FeedItem[]): string | null {
  return [...feed].reverse().find((i): i is Extract<FeedItem, { kind: "status" }> => i.kind === "status")?.detail ?? null;
}
