import type { ProjectWorkView } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import type { ModelChoice } from "../../lib/lastModel";
import { PlanCard } from "./PlanCard";
import { ProjectStart } from "./ProjectStart";
import { useProjectWork } from "./useProjectWork";
import { SiteCard } from "./Workspace";

/**
 * The project's work on its page (docs/specs/project-work.md): what to make and the models; the interview; the plan with
 * "Go"; then how the run goes, with the way into the project's conversation.
 */
export function ProjectWork({ projectId, choice }: { projectId: string; choice: ModelChoice | null }) {
  const { t, navigate, reloadTasks, tasks } = useApp();
  const { work, reload } = useProjectWork(projectId);
  const [fresh, setFresh] = useState(false);
  if (!work) return null;

  const started = work.status === "running" || work.status === "paused" || work.status === "done" || work.status === "stopped";
  // The interview's task may have failed or been stopped while the work still says "planning" (seen live: the page said
  // "the interview goes on" under a failed task): said as it is, with a way to start over.
  const planTask = tasks.find((x) => x.id === work.planTaskId);
  const interviewEnded = work.status === "planning" && !work.plan && (planTask?.status === "failed" || planTask?.status === "stopped");
  if (work.status === "idle" || (fresh && (started || interviewEnded) && work.status !== "running")) {
    return (
      <ProjectStart
        projectId={projectId}
        initial={choice}
        onStarted={(task) => {
          setFresh(false);
          void reloadTasks();
          navigate({ kind: "task", taskId: task.id });
        }}
      />
    );
  }

  const interview = work.planTaskId && (
    <button className="link" onClick={() => navigate({ kind: "task", taskId: work.planTaskId! })}>
      {t("projectWork.openInterview")}
    </button>
  );

  if (work.status === "planning" || work.status === "ready") {
    return (
      <>
        {work.status === "planning" && !work.plan && !interviewEnded && (
          <div className="note">
            <p>{t("projectWork.planning")}</p>
            {interview}
          </div>
        )}
        {interviewEnded && (
          <div className="note is-pencil">
            <p>{t(planTask?.status === "stopped" ? "projectWork.interviewStopped" : "projectWork.interviewFailed")}</p>
            <div className="actions">
              {interview}
              <button className="link" onClick={() => setFresh(true)}>
                {t("projectWork.newTask")}
              </button>
            </div>
          </div>
        )}
        {work.plan && <PlanCard key={work.plan.context} work={work} onChanged={() => void reload()} />}
        {work.plan && <p className="muted">{interview}</p>}
      </>
    );
  }

  return (
    <>
      <SiteCard work={work} onChanged={() => void reload()} />
      <section className="note work-summary">
        <WorkState work={work} />
        <p className="muted">{t("projectWork.progress", { done: work.checklist.filter((i) => i.done).length, total: work.checklist.length })}</p>
        <div className="actions">
          {work.chatId && (
            <button className="btn is-primary" onClick={() => navigate({ kind: "chat", chatId: work.chatId!, key: work.chatId! })}>
              {t("projectWork.openChat")}
            </button>
          )}
          {work.status !== "running" && (
            <button className="link" onClick={() => setFresh(true)}>
              {t("projectWork.newTask")}
            </button>
          )}
        </div>
      </section>
    </>
  );
}

/** One line on how the run goes: working, waiting for permission, done, or why it stopped. */
export function WorkState({ work }: { work: ProjectWorkView }) {
  const { t } = useApp();
  if (work.status === "running") {
    return (
      <p className={work.waitingApproval ? "work-state is-wait" : "work-state is-running"}>
        {!work.waitingApproval && <span className="action-spinner" aria-hidden />}
        {t(work.waitingApproval ? "projectWork.waitingApproval" : "projectWork.status.running")}
      </p>
    );
  }
  if (work.status === "done") return <p className="work-state is-ok">{t("projectWork.status.done")}</p>;
  if (work.status === "paused" || work.status === "stopped") {
    return (
      <p className="work-state is-wait">
        {t(`projectWork.reason.${work.reason ?? "user"}` as MessageKey, { detail: work.detail ?? "" })}
      </p>
    );
  }
  return null;
}
