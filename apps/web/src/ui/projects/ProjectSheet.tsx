import type { ModelInfo, ProjectView } from "@artel/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { formatUsd } from "../../lib/format";
import { readLastModel, type ModelChoice } from "../../lib/lastModel";
import { loadModels } from "../../lib/models";
import { ModelNote } from "../chat/ModelNote";
import { ProjectSkills } from "../SkillsSection";
import { StatusChip } from "../tasks/StatusDot";
import { Backlog } from "./Backlog";

type GitProblem = "no_identity" | "no_git" | null;
/** What the catalog says about a picked model; null while loading or when unknown. */
function useModelInfo(choice: ModelChoice | null): ModelInfo | null {
  const { api } = useApp();
  const [model, setModel] = useState<ModelInfo | null>(null);
  useEffect(() => {
    if (!choice) return setModel(null);
    let live = true;
    void loadModels(api, choice.providerId).then((r) => {
      if (live) setModel("models" in r ? (r.models.find((m) => m.id === choice.model) ?? null) : null);
    });
    return () => {
      live = false;
    };
  }, [api, choice]);
  return model;
}

export function ProjectSheet({ projectId }: { projectId: string }) {
  const { api, t, projects, tasks, providers, navigate, reloadProjects, reloadTasks } = useApp();
  const project = projects.find((p) => p.id === projectId);
  const [choice, setChoice] = useState<ModelChoice | null>(() => {
    const last = readLastModel();
    return last && providers.some((p) => p.id === last.providerId) ? last : null;
  });
  const model = useModelInfo(choice);
  const [gitProblem, setGitProblem] = useState<GitProblem>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (!project) return null;
  const own = tasks.filter((task) => task.projectId === project.id);
  const noTools = model?.tools === false;

  async function initGit(p: ProjectView) {
    setBusy(true);
    const res = await api.projects[":id"]["init-git"].$post({ param: { id: p.id } }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      setGitProblem(null);
      await reloadProjects();
      return;
    }
    const body = (await res?.json().catch(() => null)) as { error?: { code?: string } } | null;
    setGitProblem(body?.error?.code === "no_git" ? "no_git" : "no_identity");
  }

  async function remove() {
    await api.projects[":id"].$delete({ param: { id: projectId } }).catch(() => null);
    await Promise.all([reloadProjects(), reloadTasks()]);
    navigate({ kind: "home" });
  }

  return (
    <article className="sheet">
      <div className="sheet-body">
        <h1>{project.name}</h1>
        <p className="lede mono project-path">{project.path}</p>

        {project.gitState === "not_repo" ? (
          <section className="notice">
            <h2 className="sheet-h">{t("project.notRepoTitle")}</h2>
            <p>{t("project.notRepoBody")}</p>
            {gitProblem === "no_identity" && <IdentityHelp />}
            {gitProblem === "no_git" && <p className="error-note">{t("project.noGit")}</p>}
            <button className="btn is-primary" disabled={busy} onClick={() => void initGit(project)}>
              {t("project.initGit")}
            </button>
          </section>
        ) : (
          <>
            <Backlog projectId={project.id} choice={choice} onChoice={setChoice} noTools={noTools} />
            {noTools && <p className="error-note">{t("project.toolsWarning")}</p>}
          </>
        )}

        <h2 className="sheet-h">{t("project.tasks")}</h2>
        {own.length === 0 ? (
          <p className="muted">{t("project.noTasks")}</p>
        ) : (
          <ul className="task-list">
            {own.map((task) => (
              <li key={task.id}>
                <button className="task-row" onClick={() => navigate({ kind: "task", taskId: task.id })}>
                  <span className="task-row-title">{task.title}</span>
                  <StatusChip status={task.status} />
                  <span className="mono muted">{formatUsd(task.costUsd)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="actions project-remove">
          {confirmRemove ? (
            <>
              <span>{t("project.removeConfirm", { name: project.name })}</span>
              <button className="btn is-pencil" onClick={() => void remove()}>
                {t("project.remove")}
              </button>
              <button className="btn" onClick={() => setConfirmRemove(false)}>
                {t("providers.cancel")}
              </button>
            </>
          ) : (
            <button className="link" onClick={() => setConfirmRemove(true)}>
              {t("project.remove")}
            </button>
          )}
        </div>
      </div>
      <aside className="margin">
        <p className="note">{t("project.copyNote")}</p>
        <ProjectSkills projectId={project.id} />
        {choice && <ModelNote choice={choice} />}
      </aside>
    </article>
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
