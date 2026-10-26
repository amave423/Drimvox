import type { ProjectView, ProjectWorkView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { formatUsd } from "../../lib/format";
import { readLastModel, type ModelChoice } from "../../lib/lastModel";
import { ChatSheet } from "../chat/ChatSheet";
import { TaskSheet } from "../tasks/TaskSheet";
import { useAddProject } from "./AddProject";
import { LimitsForm } from "./LimitsForm";
import { PlanCard } from "./PlanCard";
import { ProjectStart } from "./ProjectStart";
import { hoursAndMinutes, useProjectWork } from "./useProjectWork";
import { WorkshopResult } from "./WorkshopResult";

const RESULT_KEY = "drimvox.workshopResult";

/**
 * A project's workshop (asked for: the projects' mode as a window of its own, variant A with variant C's timeline): the
 * project's state and controls on top, the work in the middle as it goes (the start, the interview, the plan, then the
 * agent's timeline with the box to write to it), the result on the right, which folds away.
 */
export function Workshop({ projectId }: { projectId: string }) {
  const { t, projects, providers, reloadTasks, reloadWorks } = useApp();
  const project = projects.find((p) => p.id === projectId);
  const { work, reload } = useProjectWork(projectId);
  const [fresh, setFresh] = useState(false);
  const [limits, setLimits] = useState(false);
  const [resultOpen, setResultOpen] = useState(() => {
    try {
      return localStorage.getItem(RESULT_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const [choice] = useState<ModelChoice | null>(() => {
    const last = readLastModel();
    return last && providers.some((p) => p.id === last.providerId) ? last : null;
  });
  // The sidebar shows this work's state and checklist: kept in step with what the workshop sees.
  const doneItems = work?.checklist.filter((i) => i.done).length;
  useEffect(reloadWorks, [work?.status, work?.checklist.length, doneItems]);
  // The last project opened is where the projects' mode comes back to.
  useEffect(() => {
    try {
      localStorage.setItem(LAST_PROJECT_KEY, projectId);
    } catch {
      // Not remembered.
    }
  }, [projectId]);
  if (!project) return null;

  const toggleResult = () => {
    const next = !resultOpen;
    setResultOpen(next);
    try {
      localStorage.setItem(RESULT_KEY, next ? "open" : "closed");
    } catch {
      // Kept for this visit only.
    }
  };
  const started = !!work?.startedAt && !!work.chatId;
  const stage: Stage = project.gitState === "not_repo" ? "git" : !work ? "loading" : fresh || work.status === "idle" ? "start" : work.status === "planning" && !work.plan ? "interview" : work.status === "ready" || (work.status === "planning" && work.plan) ? "plan" : started ? "work" : "start";

  return (
    <div className="workshop">
      <WorkshopHead project={project} work={work} stage={stage} onLimits={() => setLimits(!limits)} resultOpen={resultOpen} onResult={toggleResult} onChanged={() => void reload()} />
      {limits && work && <LimitsForm work={work} onSaved={() => (setLimits(false), void reload())} />}
      <div className={`workshop-body${resultOpen ? " has-result" : ""}`}>
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
          {stage === "work" && work?.chatId && <ChatSheet key={work.chatId} chatId={work.chatId} viewKey={work.chatId} workshop />}
        </section>
        {resultOpen && (
          <WorkshopResult project={project} work={work} onChanged={() => void reload()} onNew={work && work.status !== "idle" && work.status !== "running" ? () => setFresh(true) : undefined} />
        )}
      </div>
    </div>
  );
}

type Stage = "git" | "loading" | "start" | "interview" | "plan" | "work";
export const LAST_PROJECT_KEY = "drimvox.lastProject";

/** The project's name, its state in one pill, how far the work got, its time and money, and the controls. */
function WorkshopHead(p: { project: ProjectView; work: ProjectWorkView | null; stage: Stage; onLimits(): void; resultOpen: boolean; onResult(): void; onChanged(): void }) {
  const { api, t } = useApp();
  const w = p.work;
  const done = w?.checklist.filter((i) => i.done).length ?? 0;
  const total = w?.checklist.length ?? 0;
  async function act(kind: "stop" | "continue") {
    if (!w) return;
    await (kind === "stop" ? api.projects[":id"].work.stop.$post({ param: { id: w.projectId } }) : api.projects[":id"].work.continue.$post({ param: { id: w.projectId } })).catch(() => null);
    p.onChanged();
  }
  const pill = pillOf(p.stage, w);
  return (
    <header className="workshop-head">
      <div className="workshop-title">
        <h1>{p.project.name}</h1>
        <span className="mono muted">{p.project.path}</span>
      </div>
      <span className={`workshop-pill is-${pill.tone}`} role="status" title={t(pill.key, { detail: w?.detail ?? "" })}>
        {pill.tone === "run" && <span className="action-spinner" aria-hidden />}
        {t(pill.key, { detail: w?.detail ?? "" })}
      </span>
      {total > 0 && (
        <span className="workshop-progress" title={t("projectWork.progress", { done, total })}>
          <span className="workshop-bar" aria-hidden>
            <span style={{ width: `${Math.round((done / total) * 100)}%` }} />
          </span>
          {t("projectWork.progress", { done, total })}
        </span>
      )}
      <span className="spacer" />
      {w?.startedAt && (
        <button type="button" className="link workshop-numbers" onClick={p.onLimits} title={t("workshop.limits")}>
          {hoursAndMinutes(w.workedMs, t)} / {t("projectWork.hoursShort", { h: w.hours })} · {formatUsd(w.spentUsd)} / {formatUsd(w.budgetUsd)}
        </button>
      )}
      {w?.status === "running" && (
        <button className="btn is-pencil" onClick={() => void act("stop")}>
          {t("projectWork.stop")}
        </button>
      )}
      {w?.startedAt && (w.status === "paused" || w.status === "stopped") && (
        <button className="btn is-primary" onClick={() => void act("continue")}>
          {t("projectWork.continue")}
        </button>
      )}
      <button type="button" className={`btn workshop-toggle${p.resultOpen ? " is-on" : ""}`} aria-pressed={p.resultOpen} onClick={p.onResult} title={t(p.resultOpen ? "workshop.hideResult" : "workshop.showResult")}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M15 4v16" />
        </svg>
        {t("workshop.result")}
      </button>
    </header>
  );
}

function pillOf(stage: Stage, w: ProjectWorkView | null): { key: MessageKey; tone: "run" | "ok" | "wait" | "idle" } {
  if (stage === "git") return { key: "workshop.state.git", tone: "wait" };
  if (!w || stage === "start") return { key: "workshop.state.new", tone: "idle" };
  if (stage === "interview") return { key: "workshop.state.interview", tone: "run" };
  if (stage === "plan") return { key: w.status === "planning" ? "workshop.state.rewriting" : "workshop.state.plan", tone: w.status === "planning" ? "run" : "wait" };
  if (w.status === "running") return w.waitingApproval ? { key: "projectWork.waitingApproval", tone: "wait" } : { key: "projectWork.status.running", tone: "run" };
  if (w.status === "done") return { key: "workshop.state.done", tone: "ok" };
  return { key: `projectWork.reason.${w.reason ?? "user"}` as MessageKey, tone: "wait" };
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
          <ul className="home-recent workshop-recent">
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => navigate({ kind: "project", projectId: p.id })}>
                  <span className="home-recent-title">{p.name}</span>
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
