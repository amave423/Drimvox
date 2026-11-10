import { MissingFolder } from "./MissingFolder";
import type { ProjectView, ProjectWorkView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { ChatSheet } from "../chat/ChatSheet";
import { TaskSheet } from "../tasks/TaskSheet";
import { useAddProject } from "./AddProject";
import { PaneSplit, usePaneWidth } from "../PaneSplit";
import { useProjectWork } from "./useProjectWork";
import { ProjectPanel } from "./ProjectPanel";
import { ProjectComposer } from "./ProjectComposer";

export const LAST_PROJECT_KEY = "drimvox.lastProject";

export type Stage = "folder" | "git" | "loading" | "work" | "talk";

/** Where a project is (asked for: one conversation per project, as a ready project had): git first, then its conversation. */
export function stageOf(project: ProjectView, work: ProjectWorkView | null): Stage {
  if (project.gitState === "missing") return "folder";
  if (project.gitState === "not_repo") return "git";
  if (!work) return "loading";
  return work.chatId && work.startedAt ? "work" : "talk";
}

/**
 * A project's workshop: its one conversation in the middle (asked for: as a ready project had), the project on the
 * right, its width dragged at the edge between them. The controls are in the top bar (WorkshopBar), the projects and their state in the sidebar.
 */
export function Workshop({ projectId }: { projectId: string }) {
  const { t, projects, reloadWorks, reloadProjects } = useApp();
  const project = projects.find((p) => p.id === projectId);
  const { work, reload } = useProjectWork(projectId);
  const split = usePaneWidth();
  // The top bar and the sidebar show this work's state: kept in step with what the workshop sees.
  useEffect(reloadWorks, [work?.status, work?.spentUsd]);
  // Its folder looked at again on every opening: renamed meanwhile, it is followed or asked for.
  useEffect(() => void reloadProjects(), [projectId]);
  // The last project opened is where the projects' mode comes back to.
  useEffect(() => {
    try {
      localStorage.setItem(LAST_PROJECT_KEY, projectId);
    } catch {
      // Not remembered.
    }
  }, [projectId]);
  if (!project) return null;

  const stage = stageOf(project, work);

  return (
    <div className="workshop">
      <div
        className={`workshop-body${split.dragging ? " is-dragging" : ""}`}
        ref={split.body}
        style={{ gridTemplateColumns: `minmax(0, 1fr) auto ${split.width}px` }}
      >
        <section className="workshop-main" aria-label={t("workshop.work")}>
          {stage === "folder" && <MissingFolder project={project} />}
          {stage === "git" && <GitNotice project={project} />}
          {stage === "loading" && <p className="muted workshop-pad">{t("model.loading")}</p>}
          {stage === "talk" && <ReadyStart projectId={project.id} work={work} onStarted={() => void reload()} />}
          {stage === "work" && work?.chatId && (
            <div className="workshop-feed">
              <ChatSheet key={work.chatId} chatId={work.chatId} viewKey={work.chatId} workshop />
            </div>
          )}
        </section>
        <PaneSplit split={split} controls="workshop-result" label={{ open: "workshop.hideResult", closed: "workshop.showResult" }} />
        <ProjectPanel project={project} work={work} open={split.width > 0} onChanged={() => void reload()} />
      </div>
    </div>
  );
}

/** A project before its first message: what it is for, and the box with the model. */
function ReadyStart({ projectId, work, onStarted }: { projectId: string; work: ProjectWorkView | null; onStarted(): void }) {
  const { t } = useApp();
  return (
    <div className="workshop-ready">
      <div className="workshop-ready-intro">
        <h2 className="sheet-h">{t("workshop.readyTitle")}</h2>
        <p className="muted">{t("workshop.readyLede")}</p>
      </div>
      <ProjectComposer projectId={projectId} work={work} onSent={onStarted} />
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
