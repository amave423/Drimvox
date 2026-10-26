import type { ProjectView, ProjectWorkView, WorkShot } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { formatUsd } from "../../lib/format";
import { ProjectSkills } from "../SkillsSection";
import { AuthImage, ShotGallery, ShotStrip, useShotIndex, type Shot } from "../ShotGallery";
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

/** The agent's looks at the pages, one at a time in a frame (the newest first shown), then the result and the report. */
function ResultPart({ work, onChanged }: { work: ProjectWorkView; onChanged(): void }) {
  const { t } = useApp();
  return (
    <>
      {work.escalated && <p className="muted">{t("projectWork.escalated")}</p>}
      {work.shots.length > 0 && <ShotStage key={work.projectId} projectId={work.projectId} shots={work.shots} />}
      <RunTab work={work} onChanged={onChanged} />
    </>
  );
}

/**
 * One screenshot in a frame of a fixed height (seen: whole-page phone screenshots ran far down and over each other),
 * shown at its own width and scrolled inside; arrows, the count and a strip go between them (asked for), and a click
 * opens them over the window. A new one shows up by itself while the newest is being looked at.
 */
function ShotStage({ projectId, shots }: { projectId: string; shots: WorkShot[] }) {
  const { t, settings } = useApp();
  const list: Shot[] = shots.map((s) => ({
    url: `/api/projects/${projectId}/work/shots/${s.id}`,
    caption: `${s.url} · ${new Date(s.at).toLocaleTimeString(settings.locale, { hour: "2-digit", minute: "2-digit" })}`,
  }));
  const nav = useShotIndex(list.length, list.length - 1);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    if (following) nav.set(list.length - 1);
  }, [list.length, following]);
  const [open, setOpen] = useState(false);
  const shot = list[nav.index];
  if (!shot) return null;
  const go = (i: number) => {
    nav.set(i);
    setFollowing(i === list.length - 1);
  };
  return (
    <section className="shot-stage" aria-label={t("workshop.lastLook")}>
      <button type="button" className="shot-stage-frame" aria-label={t("viewer.open", { name: shot.caption ?? "" })} onClick={() => setOpen(true)} key={shot.url}>
        <AuthImage url={shot.url} alt={shot.caption ?? t("msg.screenshot")} />
      </button>
      <div className="shot-stage-bar">
        <button type="button" className="icon-button" aria-label={t("shots.prev")} disabled={nav.index === 0} onClick={() => go(nav.index - 1)}>
          ‹
        </button>
        <span className="shot-stage-count">{t("shots.count", { n: nav.index + 1, total: list.length })}</span>
        <button type="button" className="icon-button" aria-label={t("shots.next")} disabled={nav.index === list.length - 1} onClick={() => go(nav.index + 1)}>
          ›
        </button>
        <span className="shot-stage-caption mono muted" title={shot.caption}>
          {shot.caption}
        </span>
      </div>
      {list.length > 1 && <ShotStrip shots={list} index={nav.index} onPick={go} />}
      {open && <ShotGallery shots={list} start={nav.index} onClose={() => setOpen(false)} />}
    </section>
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
