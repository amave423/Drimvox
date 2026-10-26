import type { ProjectView, ProjectWorkView, WorkShot } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";
import { formatUsd } from "../../lib/format";
import { useAuthorizedUrl } from "../../lib/media";
import { ProjectSkills } from "../SkillsSection";
import { Tabs } from "../Tabs";
import { StatusChip } from "../tasks/StatusDot";
import { GithubPublish } from "./GithubPublish";
import { ChangesTab, RunTab } from "./Workspace";

type Part = "result" | "changes" | "project";
const PARTS: Part[] = ["result", "changes", "project"];

/**
 * The workshop's right side, its width set by the handle beside it: what came of the work (the agent's last look at
 * the page, large, the started result and the report), the folder's changes, and the project itself.
 */
export function WorkshopResult(p: { project: ProjectView; work: ProjectWorkView | null; open: boolean; onChanged(): void; onNew?: () => void }) {
  const { t } = useApp();
  const [part, setPart] = useState<Part>("result");
  const { work } = p;
  return (
    <aside id="workshop-result" className="workshop-result" aria-label={t("workshop.result")} aria-hidden={!p.open} inert={!p.open}>
      <div className="workshop-tabs">
        <Tabs<Part> value={part} label={t("workshop.result")} options={PARTS.map((x) => ({ value: x, label: t(`workshop.part.${x}`) }))} onChange={setPart} />
      </div>
      <div className="workshop-result-body">
        {part === "result" && (work?.startedAt ? <ResultPart work={work} onChanged={p.onChanged} /> : <p className="muted">{t("workshop.noResult")}</p>)}
        {part === "changes" && (work ? <ChangesTab work={work} /> : null)}
        {part === "project" && <ProjectPart project={p.project} onNew={p.onNew} />}
      </div>
    </aside>
  );
}

/** The agent's newest look at the page, large as a preview; the ones before it small; then the result and the report. */
function ResultPart({ work, onChanged }: { work: ProjectWorkView; onChanged(): void }) {
  const { t } = useApp();
  const [latest, ...before] = [...work.shots].reverse().slice(0, 4);
  return (
    <>
      {work.escalated && <p className="muted">{t("projectWork.escalated")}</p>}
      {latest && (
        <section className="workshop-shots" aria-label={t("workshop.lastLook")}>
          <Shot projectId={work.projectId} shot={latest} />
          {before.length > 0 && (
            <div className="workshop-shots-before">
              {before.map((s) => (
                <Shot key={s.id} projectId={work.projectId} shot={s} small />
              ))}
            </div>
          )}
        </section>
      )}
      <RunTab work={work} onChanged={onChanged} />
    </>
  );
}

function Shot({ projectId, shot, small }: { projectId: string; shot: WorkShot; small?: boolean }) {
  const { t, token, settings } = useApp();
  const src = useAuthorizedUrl(`/api/projects/${projectId}/work/shots/${shot.id}`, token);
  return (
    <figure className={`workshop-shot${small ? " is-small" : ""}`}>
      {src ? <img src={src} alt={shot.url} /> : <div className="workshop-shot-wait" />}
      <figcaption className="mono muted">
        <span>{shot.url}</span>
        {!small && <span>{t("workshop.shotAt", { time: new Date(shot.at).toLocaleTimeString(settings.locale, { hour: "2-digit", minute: "2-digit" }) })}</span>}
      </figcaption>
    </figure>
  );
}

/** The project itself: its folder, its tasks, skills, GitHub, a new task, and leaving Drimvox. */
function ProjectPart({ project, onNew }: { project: ProjectView; onNew?: () => void }) {
  const { api, t, tasks, navigate, reloadProjects, reloadTasks } = useApp();
  const [confirm, setConfirm] = useState(false);
  const own = tasks.filter((task) => task.projectId === project.id);
  async function remove() {
    await api.projects[":id"].$delete({ param: { id: project.id } }).catch(() => null);
    await Promise.all([reloadProjects(), reloadTasks()]);
    navigate({ kind: "projects" });
  }
  return (
    <div className="workshop-project">
      <p className="mono muted">{project.path}</p>
      {onNew && (
        <button className="btn" onClick={onNew}>
          {t("projectWork.newTask")}
        </button>
      )}
      <h3 className="margin-h">{t("project.tasks")}</h3>
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
      <p className="note">{t("project.copyNote")}</p>
      <ProjectSkills projectId={project.id} />
      {project.gitState === "ready" && <GithubPublish project={project} />}
      <div className="actions project-remove">
        {confirm ? (
          <>
            <span>{t("project.removeConfirm", { name: project.name })}</span>
            <button className="btn is-pencil" onClick={() => void remove()}>
              {t("project.remove")}
            </button>
            <button className="btn" onClick={() => setConfirm(false)}>
              {t("providers.cancel")}
            </button>
          </>
        ) : (
          <button className="link" onClick={() => setConfirm(true)}>
            {t("project.remove")}
          </button>
        )}
      </div>
    </div>
  );
}
