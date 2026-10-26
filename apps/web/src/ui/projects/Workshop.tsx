import type { ProjectView, ProjectWorkView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { readLastModel, type ModelChoice } from "../../lib/lastModel";
import { ChatSheet } from "../chat/ChatSheet";
import { Tabs } from "../Tabs";
import { TaskSheet } from "../tasks/TaskSheet";
import { useAddProject } from "./AddProject";
import { PlanCard } from "./PlanCard";
import { ProjectStart } from "./ProjectStart";
import { PaneSplit, usePaneWidth } from "../PaneSplit";
import { useProjectWork } from "./useProjectWork";
import { PlanTab } from "./Workspace";
import { WorkshopResult } from "./WorkshopResult";

export const LAST_PROJECT_KEY = "drimvox.lastProject";

export type Stage = "git" | "loading" | "start" | "interview" | "plan" | "work";

/** Where a project's work is: git first, the start, the interview, the plan, then the work itself. */
export function stageOf(project: ProjectView, work: ProjectWorkView | null, fresh = false): Stage {
  if (project.gitState === "not_repo") return "git";
  if (!work) return "loading";
  if (fresh || work.status === "idle") return "start";
  if (work.status === "planning" && !work.plan) return "interview";
  if (work.status === "ready" || work.status === "planning") return "plan";
  return work.startedAt && work.chatId ? "work" : "start";
}

type Part = "work" | "plan" | "questions";

/**
 * A project's workshop (asked for: variant A with variant C's timeline): the work in the middle as it goes (the start,
 * the interview, the plan, then the agent's timeline with its plan and questions beside it in tabs), the result on the
 * right, its width dragged by the handle between them, folded away at the edge. The state and the controls are in the
 * top bar (WorkshopBar), the projects and the checklist in the sidebar.
 */
export function Workshop({ projectId }: { projectId: string }) {
  const { t, projects, providers, reloadTasks, reloadWorks } = useApp();
  const project = projects.find((p) => p.id === projectId);
  const { work, reload } = useProjectWork(projectId);
  const [fresh, setFresh] = useState(false);
  const [part, setPart] = useState<Part>("work");
  const split = usePaneWidth();
  const [choice] = useState<ModelChoice | null>(() => {
    const last = readLastModel();
    return last && providers.some((p) => p.id === last.providerId) ? last : null;
  });
  // The top bar and the sidebar show this work's state and checklist: kept in step with what the workshop sees.
  const doneItems = work?.checklist.filter((i) => i.done).length;
  useEffect(reloadWorks, [work?.status, work?.checklist.length, doneItems, work?.spentUsd, work?.questions.length]);
  // The last project opened is where the projects' mode comes back to.
  useEffect(() => {
    try {
      localStorage.setItem(LAST_PROJECT_KEY, projectId);
    } catch {
      // Not remembered.
    }
  }, [projectId]);
  if (!project) return null;

  const stage = stageOf(project, work, fresh);
  const questions = work?.questions.length ?? 0;

  return (
    <div className="workshop">
      <div className={`workshop-body${split.dragging ? " is-dragging" : ""}`} ref={split.body} style={{ gridTemplateColumns: `minmax(0, 1fr) auto ${split.width}px` }}>
        <section className="workshop-main" aria-label={t("workshop.work")}>
          {stage === "git" && <GitNotice project={project} />}
          {stage === "loading" && <p className="muted workshop-pad">{t("model.loading")}</p>}
          {stage === "start" && (
            <div className="workshop-pad workshop-scroll">
              <ProjectStart
                projectId={project.id}
                initial={choice}
                onStarted={() => {
                  setFresh(false);
                  void reload();
                  void reloadTasks();
                }}
              />
            </div>
          )}
          {stage === "interview" && work?.planTaskId && <TaskSheet key={work.planTaskId} taskId={work.planTaskId} embedded />}
          {stage === "plan" && work && (
            <div className="workshop-pad workshop-scroll">
              <PlanCard key={work.plan?.context} work={work} onChanged={() => void reload()} />
            </div>
          )}
          {stage === "work" && work?.chatId && (
            <>
              <div className="workshop-tabs">
                <Tabs<Part>
                  value={part}
                  label={t("workshop.work")}
                  options={[
                    { value: "work", label: t("workshop.part.work") },
                    { value: "plan", label: t("workshop.part.plan") },
                    { value: "questions", label: questions ? t("workshop.part.questionsN", { n: questions }) : t("workshop.part.questions") },
                  ]}
                  onChange={setPart}
                />
              </div>
              {/* The timeline stays put while another tab is open: what is typed in its box is kept. */}
              <div className="workshop-feed" hidden={part !== "work"}>
                <ChatSheet key={work.chatId} chatId={work.chatId} viewKey={work.chatId} workshop />
              </div>
              {part === "plan" && (
                <div className="workshop-pad workshop-scroll">
                  <PlanTab work={work} />
                </div>
              )}
              {part === "questions" && <Questions work={work} />}
            </>
          )}
        </section>
        <PaneSplit split={split} controls="workshop-result" label={{ open: "workshop.hideResult", closed: "workshop.showResult" }} />
        <WorkshopResult
          project={project}
          work={work}
          open={split.width > 0}
          onChanged={() => void reload()}
          onNew={work && work.status !== "idle" && work.status !== "running" ? () => setFresh(true) : undefined}
        />
      </div>
    </div>
  );
}

/** What the agent asked without waiting, with what it assumes meanwhile; answered by a message in the timeline. */
function Questions({ work }: { work: ProjectWorkView }) {
  const { t } = useApp();
  if (work.questions.length === 0) return <p className="muted workshop-pad">{t("workshop.noQuestions")}</p>;
  return (
    <div className="workshop-pad workshop-scroll">
      <ul className="work-questions">
        {[...work.questions].reverse().map((q, n) => (
          <li key={n} className="work-question">
            <p>{q.question}</p>
            <p className="muted">{t("projectWork.assumes", { assumption: q.assumption })}</p>
          </li>
        ))}
      </ul>
      <p className="muted">{t("projectWork.answerHint")}</p>
    </div>
  );
}

/** A folder without git: the work needs it first (the agent works right in the folder, git keeps the history). */
function GitNotice({ project }: { project: ProjectView }) {
  const { api, t, reloadProjects } = useApp();
  const [problem, setProblem] = useState<"no_identity" | "no_git" | null>(null);
  const [busy, setBusy] = useState(false);
  async function initGit() {
    setBusy(true);
    const res = await api.projects[":id"]["init-git"].$post({ param: { id: project.id } }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      setProblem(null);
      await reloadProjects();
      return;
    }
    const body = (await res?.json().catch(() => null)) as { error?: { code?: string } } | null;
    setProblem(body?.error?.code === "no_git" ? "no_git" : "no_identity");
  }
  return (
    <section className="notice workshop-pad">
      <h2 className="sheet-h">{t("project.notRepoTitle")}</h2>
      <p>{t("project.notRepoBody")}</p>
      {problem === "no_identity" && <IdentityHelp />}
      {problem === "no_git" && <p className="error-note">{t("project.noGit")}</p>}
      <button className="btn is-primary" disabled={busy} onClick={() => void initGit()}>
        {t("project.initGit")}
      </button>
    </section>
  );
}

export function IdentityHelp() {
  const { t } = useApp();
  return (
    <div className="error-note">
      <p>{t("project.noIdentity")}</p>
      <pre className="mono">{`git config --global user.name "${t("project.identityName")}"\ngit config --global user.email "you@example.com"`}</pre>
    </div>
  );
}

/** The projects' mode before a project is open: the way to add one, and the ones there are. */
export function ProjectsStart() {
  const { t, projects, navigate } = useApp();
  const add = useAddProject();
  return (
    <div className="workshop">
      <div className="workshop-empty">
        <h1 className="home-greet">{t("workshop.emptyTitle")}</h1>
        <p className="home-lede">{t("workshop.emptyLede")}</p>
        <div className="actions home-actions">
          <button className="btn is-primary" onClick={() => void add.pick()}>
            {t("workshop.add")}
          </button>
        </div>
        {add.failed && <p className="error-note">{t("project.addFailed")}</p>}
        {projects.length > 0 && (
          <ul className="workshop-recent">
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => navigate({ kind: "project", projectId: p.id })}>
                  <span className="workshop-recent-title">{p.name}</span>
                  <span className="muted mono">{p.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
