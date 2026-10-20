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
import { ApprovalCard } from "./Approval";
import { DesignNote } from "./Design";
import { PlanReview } from "./PlanReview";
import { Review } from "./Review";
import { SpecReview } from "./SpecReview";
import { PhaseSteps } from "./Stages";
import { StatusChip } from "./StatusDot";
import { GoalLink, SubtaskBoard } from "./Subtasks";
import { useTaskStream } from "./useTaskStream";
import { ProjectPlanHere } from "../projects/ProjectPlanHere";

const REVIEW_STATES = new Set(["review", "done_empty", "accepted", "discarded"]);
/** Waiting states with their own controls below the notice. */
const ANSWERED_BELOW = new Set(["questions", "spec_review", "plan_review", "plan_ready"]);
/** Waiting states where the work stopped short and only "Continue" moves it on. */
const UNFINISHED = new Set(["budget", "steps", "acceptance_error"]);
/** Waiting states whose last status line explains what went wrong. */
const WITH_DETAIL = new Set(["stuck", "integration_red", "subtask_stuck", "visual_failed"]);

export function TaskSheet({ taskId }: { taskId: string }) {
  const { api, t, settings, navigate } = useApp();
  const { task, events } = useTaskStream(taskId);
  const [comments, setComments] = useState<LineComment[]>([]);

  if (!task) return <article className="sheet" aria-busy />;
  // A subtask's brief is written for the model; the user sees what the subtask is about instead.
  const feed = buildFeed(events).map((item) =>
    task.kind === "subtask" && item.kind === "user" && item.text.includes("Subtask id: ") ? { ...item, text: task.task } : item,
  );
  // Stuck on checks or on the visual check: the work so far can still be reviewed and accepted.
  const stuck = task.status === "waiting" && (task.statusReason === "stuck" || task.statusReason === "visual_failed");
  // A subtask is never reviewed on its own: the goal merges it and the user reviews the goal.
  const answered = task.status === "done_empty" && task.statusReason === "answered";
  // A plan's interview ends in the project's task list: nothing to review here.
  const listed = task.status === "done_empty" && task.statusReason === "listed";
  // A project's plan went on to the work: it goes on in the project's conversation (docs/specs/project-work.md).
  const started = task.status === "done_empty" && task.statusReason === "started";
  const reviewing = task.kind !== "subtask" && !answered && !listed && !started && (REVIEW_STATES.has(task.status) || stuck);
  const waitingFor = task.status === "waiting" ? task.statusReason : null;
  // Failed, stopped or out of budget: what is done so far can be looked at and taken as it is.
  const unfinished =
    task.kind !== "subtask" &&
    !reviewing &&
    !answered &&
    (task.status === "failed" || task.status === "stopped" || (task.status === "waiting" && UNFINISHED.has(task.statusReason ?? "")));

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
          {task.milestones.length > 1 && (task.status === "running" || task.status === "waiting") && (
            <p className="muted stage-now">
              {t("task.stageNow", { stage: Math.min(task.milestone, task.milestones.length), total: task.milestones.length })}:{" "}
              {task.milestones[Math.min(task.milestone, task.milestones.length) - 1]?.title}
            </p>
          )}
        </header>

        <TaskNotice task={task} feed={feed} onAnswer={answer} />
        {unfinished && (
          <details className="worked so-far">
            <summary>{t("review.soFar")}</summary>
            <Review task={task} comments={comments} setComments={setComments} partial />
          </details>
        )}
        {waitingFor === "questions" && <Interview key={task.updatedAt} task={task} />}
        {waitingFor === "spec_review" && <SpecReview key={task.spec ?? ""} task={task} />}
        {waitingFor === "plan_review" && <PlanReview key={task.updatedAt} task={task} />}
        {(waitingFor === "plan_ready" || started) && <ProjectPlanHere projectId={task.projectId} />}
        {task.subtasks.length > 0 && <SubtaskBoard task={task} />}

        {answered && <Answer task={task} />}
        {listed && (
          <div className="note is-ok">
            <p>{t("backlog.listed")}</p>
            <button className="btn is-primary" onClick={() => navigate({ kind: "project", projectId: task.projectId })}>
              {t("backlog.toList")}
            </button>
          </div>
        )}
        {answered || listed || started ? (
          <details className="worked">
            <summary>{t(listed || started ? "review.howWorked" : "answer.howFound")}</summary>
            <Feed items={feed} taskId={task.id} />
          </details>
        ) : reviewing ? (
          <>
            <Review task={task} comments={comments} setComments={setComments} />
            <details className="worked">
              <summary>{t("review.howWorked")}</summary>
              <Feed items={feed} taskId={task.id} />
            </details>
          </>
        ) : (
          <>
            <h2 className="sheet-h">{t("task.feed")}</h2>
            <Feed items={feed} taskId={task.id} />
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
        {task.design && <DesignNote brief={task.design} />}
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
function TaskNotice({ task, feed, onAnswer }: { task: TaskView; feed: FeedItem[]; onAnswer(approvalId: string, allow: boolean, always?: boolean): void }) {
  const { api, t, settings, navigate } = useApp();
  const stop = () => void api.tasks[":id"].stop.$post({ param: { id: task.id } }).catch(() => null);
  const carryOn = () => void api.tasks[":id"].continue.$post({ param: { id: task.id }, json: {} }).catch(() => null);
  const drop = () => void api.tasks[":id"].drop.$post({ param: { id: task.id } }).catch(() => null);
  // A subtask that cannot go on can leave the goal; the rest of the team carries on without it.
  const dropButton = task.kind === "subtask" && (
    <button className="btn is-pencil" onClick={drop}>
      {t("team.drop")}
    </button>
  );

  // The question is answered here, at the top, next to Stop: not at the bottom of a long feed.
  if (task.status === "waiting" && task.statusReason === "approval" && task.pendingApproval) {
    return (
      <div className="task-notice is-wait is-asking">
        <ApprovalCard approval={task.pendingApproval} allowed={null} onAnswer={onAnswer} />
        <button className="btn is-pencil" onClick={stop}>
          {t("task.stop")}
        </button>
      </div>
    );
  }
  const asker = task.subtasks.find((s) => s.status === "waiting" && s.statusReason === "approval");
  const asking = task.status === "waiting" && (task.statusReason === "approval" || task.statusReason === "subtask_waiting");
  if (task.status === "running" || asking) {
    const working = task.kind === "goal" && task.phase === "orchestrate" ? "team.working" : "task.working";
    return (
      <div className={`task-notice${asking ? " is-wait" : ""}`}>
        {!asking && <span className="action-spinner" aria-hidden />}
        <p>{t(asking ? (task.statusReason === "approval" ? "task.waitingApproval" : "team.subtaskAsks") : working)}</p>
        {asking && asker && (
          <button className="btn is-primary" onClick={() => navigate({ kind: "task", taskId: asker.taskId })}>
            {t("team.openAsker", { title: asker.title })}
          </button>
        )}
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

  // Between the stages of a big task: on to the next one, or review what is done.
  if (task.status === "waiting" && task.statusReason === "milestone_review") {
    const doneStage = task.milestone - 1;
    const finishEarly = () => void api.tasks[":id"]["finish-early"].$post({ param: { id: task.id } }).catch(() => null);
    return (
      <div className="task-notice is-wait">
        <p>{t("task.milestoneDone", { stage: doneStage, total: task.milestones.length, title: task.milestones[doneStage - 1]?.title ?? "" })}</p>
        <button className="btn is-primary" onClick={carryOn}>
          {t("task.nextStage", { stage: task.milestone })}
        </button>
        <button className="btn" onClick={finishEarly}>
          {t("task.stagesEnough")}
        </button>
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
