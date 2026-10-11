import type { ModelInfo, ProjectView, TaskView } from "@artel/shared";
import { useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { formatUsd } from "../../lib/format";
import { readLastModel, rememberLastModel, type ModelChoice } from "../../lib/lastModel";
import { loadModels } from "../../lib/models";
import { ModelPicker } from "../chat/ModelPicker";
import { ModelNote } from "../chat/ModelNote";
import { StatusChip } from "../tasks/StatusDot";

type GitProblem = "no_identity" | "no_git" | null;

export function ProjectSheet({ projectId }: { projectId: string }) {
  const { api, t, projects, tasks, providers, navigate, reloadProjects, reloadTasks } = useApp();
  const project = projects.find((p) => p.id === projectId);
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<ModelChoice | null>(() => {
    const last = readLastModel();
    return last && providers.some((p) => p.id === last.providerId) ? last : null;
  });
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [gitProblem, setGitProblem] = useState<GitProblem>(null);
  const [startFailed, setStartFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

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

  async function start() {
    if (!choice || !text.trim()) return;
    setBusy(true);
    setStartFailed(false);
    const task = await api.projects[":id"].tasks
      .$post({ param: { id: projectId }, json: { task: text.trim(), providerId: choice.providerId, model: choice.model } })
      .then((r) => ok<TaskView>(r))
      .catch(() => null);
    setBusy(false);
    if (!task) return setStartFailed(true);
    rememberLastModel(choice);
    setText("");
    await reloadTasks();
    navigate({ kind: "task", taskId: task.id });
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
          <section>
            <h2 className="sheet-h">{t("project.newTask")}</h2>
            <form
              className="task-form"
              onSubmit={(e) => {
                e.preventDefault();
                void start();
              }}
            >
              <textarea
                className="field-input task-input"
                rows={5}
                value={text}
                placeholder={t("project.taskPlaceholder")}
                aria-label={t("project.newTask")}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="actions">
                <ModelPicker value={choice} onChange={setChoice} />
                <button className="btn is-primary" disabled={busy || !choice || !text.trim() || noTools}>
                  {t("project.start")}
                </button>
              </div>
              {noTools && <p className="error-note">{t("project.toolsWarning")}</p>}
              {startFailed && <p className="error-note">{t("project.startFailed")}</p>}
            </form>
          </section>
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
