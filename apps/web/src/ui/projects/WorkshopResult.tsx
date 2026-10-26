import type { ProjectView, ProjectWorkView } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";
import { formatUsd } from "../../lib/format";
import { useAuthorizedUrl } from "../../lib/media";
import { ProjectSkills } from "../SkillsSection";
import { Tabs } from "../Tabs";
import { StatusChip } from "../tasks/StatusDot";
import { GithubPublish } from "./GithubPublish";
import { ChangesTab, PlanTab, RunTab } from "./Workspace";

type Part = "result" | "changes" | "plan" | "project";
const PARTS: Part[] = ["result", "changes", "plan", "project"];

/**
 * The workshop's right side, folded away by its button in the header: what came of the work (the last looks at the
 * pages, the started result and the report), the folder's changes, the plan, and the project itself.
 */
export function WorkshopResult({ project, work, onChanged, onNew }: { project: ProjectView; work: ProjectWorkView | null; onChanged(): void; onNew?: () => void }) {
  const { t } = useApp();
  const [part, setPart] = useState<Part>("result");
  return (
    <aside className="workshop-result" aria-label={t("workshop.result")}>
      <Tabs<Part> value={part} label={t("workshop.result")} options={PARTS.map((p) => ({ value: p, label: t(`workshop.part.${p}`) }))} onChange={setPart} />
      <div className="workshop-result-body">
        {part === "result" && (work?.startedAt ? <ResultPart work={work} onChanged={onChanged} /> : <p className="muted">{t("workshop.noResult")}</p>)}
        {part === "changes" && (work ? <ChangesTab work={work} /> : null)}
        {part === "plan" && (work ? <PlanTab work={work} /> : null)}
        {part === "project" && <ProjectPart project={project} onNew={onNew} />}
      </div>
    </aside>
  );
}

/** The newest looks the agent took at the pages, large, then the started result and the report. */
function ResultPart({ work, onChanged }: { work: ProjectWorkView; onChanged(): void }) {
  const { t } = useApp();
  const shots = [...work.shots].reverse().slice(0, 4);
  return (
    <>
      {work.escalated && <p className="muted">{t("projectWork.escalated")}</p>}
      {shots.length > 0 && (
        <section className="workshop-shots">
          <p className="muted">{t("workshop.lastLook")}</p>
          {shots.map((s) => (
            <Shot key={s.id} projectId={work.projectId} id={s.id} url={s.url} />
          ))}
        </section>
      )}
      <RunTab work={work} onChanged={onChanged} />
    </>
  );
}

function Shot({ projectId, id, url }: { projectId: string; id: string; url: string }) {
  const { token } = useApp();
  const src = useAuthorizedUrl(`/api/projects/${projectId}/work/shots/${id}`, token);
  return (
    <figure className="workshop-shot">
      {src ? <img src={src} alt={url} /> : <div className="workshop-shot-wait" />}
      <figcaption className="mono muted">{url}</figcaption>
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
