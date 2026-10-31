import type { ProjectKind, ProjectView, ProjectWorkView } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";
import { formatUsd } from "../../lib/format";
import { ProjectSkills } from "../SkillsSection";
import { Tabs } from "../Tabs";
import { StatusChip } from "../tasks/StatusDot";
import { GithubPublish } from "./GithubPublish";
import { ChangesTab, RunTab } from "./Workspace";

type Part = "result" | "changes" | "project";
// The project first (asked for), then what changed, then what came of it.
const PARTS: Part[] = ["project", "changes", "result"];

/**
 * The workshop's right side, its width set by the handle beside it: what came of the work (the agent's last look at
 * the page, large, the started result and the report), the folder's changes, and the project itself.
 */
export function WorkshopResult(p: { project: ProjectView; work: ProjectWorkView | null; open: boolean; onChanged(): void; onNew?: () => void }) {
  const { t } = useApp();
  const [part, setPart] = useState<Part>("project");
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

/** What came of the work: the started result, the report and the publishing. The screenshots stay in the timeline,
 *  where they were taken (asked for: here they read as the result itself, and the report under them went unseen). */
function ResultPart({ work, onChanged }: { work: ProjectWorkView; onChanged(): void }) {
  const { t } = useApp();
  return (
    <>
      {work.escalated && <p className="muted">{t("projectWork.escalated")}</p>}
      <RunTab work={work} onChanged={onChanged} />
    </>
  );
}

/** The project itself: its folder and kind, its tasks, skills, GitHub, a new task, and leaving Drimvox. */
function ProjectPart({ project, onNew }: { project: ProjectView; onNew?: () => void }) {
  const { api, t, tasks, navigate, reloadProjects } = useApp();
  const own = tasks.filter((task) => task.projectId === project.id);
  async function setKind(kind: ProjectKind) {
    await api.projects[":id"].$patch({ param: { id: project.id }, json: { kind } }).catch(() => null);
    await reloadProjects();
  }
  return (
    <div className="workshop-project">
      <p className="mono muted">{project.path}</p>
      <div className="project-kind-switch" role="group" aria-label={t("project.kindLabel")}>
        <span className="muted">{t("project.kindLabel")}</span>
        <span className="segmented">
          {(["existing", "new"] as const).map((k) => (
            <button key={k} type="button" className={project.kind === k ? "is-on" : undefined} aria-pressed={project.kind === k} onClick={() => project.kind !== k && void setKind(k)}>
              {t(`project.kind.${k}`)}
            </button>
          ))}
        </span>
      </div>
      {onNew && project.kind !== "existing" && (
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
      <RemoveProject project={project} />
    </div>
  );
}

/**
 * Leaving Drimvox, set apart at the end of the project's tab (asked for: it was hard to find); the folder stays. The
 * sidebar's "⋯" leads here too.
 */
export function RemoveProject({ project, onDone, asked = false }: { project: ProjectView; onDone?: () => void; asked?: boolean }) {
  const { api, t, navigate, reloadProjects, reloadTasks } = useApp();
  const [confirm, setConfirm] = useState(asked);
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    await api.projects[":id"].$delete({ param: { id: project.id } }).catch(() => null);
    await Promise.all([reloadProjects(), reloadTasks()]);
    setBusy(false);
    onDone?.();
    navigate({ kind: "projects" });
  }
  return (
    <section className="danger-zone" aria-label={t("project.remove")}>
      <p className="muted">{t("project.removeHint")}</p>
      {confirm ? (
        <div className="actions">
          <span>{t("project.removeConfirm", { name: project.name })}</span>
          <button className="btn is-pencil" disabled={busy} onClick={() => void remove()}>
            {t("project.remove")}
          </button>
          <button
            className="btn"
            onClick={() => {
              setConfirm(false);
              if (asked) onDone?.();
            }}
          >
            {t("providers.cancel")}
          </button>
        </div>
      ) : (
        <button className="btn is-pencil" onClick={() => setConfirm(true)}>
          {t("project.removeAsk")}
        </button>
      )}
    </section>
  );
}
