import type { ModelInfo, ProjectView, TaskView } from "@artel/shared";
import { useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { formatUsd } from "../../lib/format";
import { readLastModel, rememberLastModel, TEAM_MODEL_KEY, type ModelChoice } from "../../lib/lastModel";
import { loadModels } from "../../lib/models";
import { ModelPicker } from "../chat/ModelPicker";
import { ModelNote } from "../chat/ModelNote";
import { ProjectSkills } from "../SkillsSection";
import { StageSwitches, readStages } from "../tasks/Stages";
import { StatusChip } from "../tasks/StatusDot";

type GitProblem = "no_identity" | "no_git" | null;
type Mode = "solo" | "team";

const MODE_KEY = "artel.taskMode";

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "team" ? "team" : "solo";
  } catch {
    return "solo";
  }
}

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
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<ModelChoice | null>(() => {
    const last = readLastModel();
    return last && providers.some((p) => p.id === last.providerId) ? last : null;
  });
  const [mode, setModeState] = useState<Mode>(readMode);
  const [teamChoice, setTeamChoice] = useState<ModelChoice | null>(() => {
    const last = readLastModel(TEAM_MODEL_KEY);
    return last && providers.some((p) => p.id === last.providerId) ? last : null;
  });
  const model = useModelInfo(choice);
  const teamModel = useModelInfo(mode === "team" ? teamChoice : null);
  const [stages, setStages] = useState(readStages);
  const [gitProblem, setGitProblem] = useState<GitProblem>(null);
  const [startFailed, setStartFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (!project) return null;
  const own = tasks.filter((task) => task.projectId === project.id);
  const team = mode === "team";
  const noTools = model?.tools === false || (team && teamModel?.tools === false);
  const ready = !!choice && !!text.trim() && (!team || !!teamChoice);

  function setMode(next: Mode) {
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Without storage the next visit starts with one agent.
    }
  }

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
    if (!choice || !ready) return;
    setBusy(true);
    setStartFailed(false);
    const json = { task: text.trim(), providerId: choice.providerId, model: choice.model, stages, ...(team && teamChoice ? { team: teamChoice } : {}) };
    const task = await api.projects[":id"].tasks
      .$post({ param: { id: projectId }, json })
      .then((r) => ok<TaskView>(r))
      .catch(() => null);
    setBusy(false);
    if (!task) return setStartFailed(true);
    rememberLastModel(choice);
    if (team && teamChoice) rememberLastModel(teamChoice, TEAM_MODEL_KEY);
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
              <fieldset className="mode-switch">
                <legend className="visually-hidden">{t("team.mode")}</legend>
                {(["solo", "team"] as const).map((m) => (
                  <label key={m} className={mode === m ? "is-on" : undefined}>
                    <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
                    {t(`team.mode.${m}`)}
                  </label>
                ))}
              </fieldset>
              <StageSwitches value={stages} onChange={setStages} team={team} />
              {team ? (
                <div className="team-models">
                  <div className="team-model">
                    <span>{t("team.lead")}</span>
                    <ModelPicker value={choice} onChange={setChoice} />
                  </div>
                  <div className="team-model">
                    <span>{t("team.worker")}</span>
                    <ModelPicker value={teamChoice} onChange={setTeamChoice} />
                  </div>
                  <button className="btn is-primary" disabled={busy || !ready || noTools}>
                    {t("team.start")}
                  </button>
                </div>
              ) : (
                <div className="actions">
                  <ModelPicker value={choice} onChange={setChoice} />
                  <button className="btn is-primary" disabled={busy || !ready || noTools}>
                    {t("project.start")}
                  </button>
                </div>
              )}
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
        <p className="note">{t(team ? "team.note" : "project.copyNote")}</p>
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
