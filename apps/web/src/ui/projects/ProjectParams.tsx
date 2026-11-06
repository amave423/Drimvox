import type { ProjectView, ProjectWorkView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { useBoxPrefs } from "../../lib/boxPrefs";
import { ModelPicker } from "../chat/ModelPicker";
import { ThinkingSwitch } from "../chat/ThinkingSwitch";
import { Toggle } from "../Toggle";
import { GithubPublish } from "./GithubPublish";
import { ProjectGitCard } from "./ProjectGitCard";
import { PublishSiteCard } from "./Workspace";

interface Extensions {
  skills: { name: string; description: string; own: boolean; on: boolean }[];
  mcp: { id: string; name: string; on: boolean; installed: boolean }[];
}

/**
 * A project's parameters, in the lower part of the right side (asked for: they were a pop-up under the box and a tab
 * of things not about the project): how the work goes, the skills and MCP servers this project uses of the downloaded
 * ones, and its git and GitHub.
 */
export function ProjectParams({ project, work }: { project: ProjectView; work: ProjectWorkView | null }) {
  const { t } = useApp();
  return (
    <div className="project-params">
      <WorkOptions projectId={project.id} />
      <ProjectExtensions projectId={project.id} />
      {project.gitState === "ready" && (
        <section className="params-block" aria-labelledby="params-git-h">
          <h3 className="margin-h" id="params-git-h">
            {t("projectParams.git")}
          </h3>
          <ProjectGitCard project={project} busy={work?.status === "running"} />
          <GithubPublish project={project} />
          {work?.startedAt && work.status !== "running" && <PublishSiteCard projectId={project.id} />}
        </section>
      )}
    </div>
  );
}

/** Whether an interview and a plan come first, their models, the strong model, the thinking (useBoxPrefs). */
function WorkOptions({ projectId }: { projectId: string }) {
  const { t } = useApp();
  const [prefs, set] = useBoxPrefs(projectId);
  const model = (key: "interviewModel" | "planModel" | "strong", empty: "projectBox.asWorking" | "projectBox.noStrong") => (
    <span className="options-model">
      <ModelPicker value={prefs[key]} onChange={(m) => set({ [key]: m })} placement="above" />
      {prefs[key] ? (
        <button type="button" className="link" onClick={() => set({ [key]: null })}>
          {t(key === "strong" ? "projectWork.strongRemove" : "projectBox.asWorking")}
        </button>
      ) : (
        <span className="muted">{t(empty)}</span>
      )}
    </span>
  );
  return (
    <section className="params-block" aria-labelledby="params-work-h">
      <h3 className="margin-h" id="params-work-h">
        {t("projectParams.work")}
      </h3>
      <Toggle checked={prefs.interview} onChange={(interview) => set({ interview })}>
        <span>
          {t("projectBox.interview")} <span className="options-about">{t("projectBox.interviewHint")}</span>
        </span>
      </Toggle>
      <Toggle checked={prefs.plan} onChange={(plan) => set({ plan })}>
        <span>
          {t("projectBox.plan")} <span className="options-about">{t("projectBox.planHint")}</span>
        </span>
      </Toggle>
      {prefs.interview && (
        <div className="params-row">
          <span className="muted">{t("projectBox.interviewModel")}</span>
          {model("interviewModel", "projectBox.asWorking")}
        </div>
      )}
      {prefs.plan && (
        <div className="params-row">
          <span className="muted">{t("projectBox.planModel")}</span>
          {model("planModel", "projectBox.asWorking")}
        </div>
      )}
      <div className="params-row">
        <span className="muted">{t("projectBox.strong")}</span>
        {model("strong", "projectBox.noStrong")}
      </div>
      <div className="params-row">
        <span className="muted">{t("thinking.label")}</span>
        <ThinkingSwitch value={prefs.thinking} onChange={(thinking) => set({ thinking })} />
      </div>
    </section>
  );
}

/** The downloaded skills and MCP servers this project uses (asked for: switched on per project, not for all). */
function ProjectExtensions({ projectId }: { projectId: string }) {
  const { api, t, navigate } = useApp();
  const [ext, setExt] = useState<Extensions | null>(null);
  useEffect(() => {
    void api.projects[":id"].extensions
      .$get({ param: { id: projectId } })
      .then((r) => ok<Extensions>(r))
      .then(setExt)
      .catch(() => setExt(null));
  }, [api, projectId]);
  if (!ext) return null;

  async function save(patch: { skills?: string[]; mcp?: string[] }) {
    const next = await api.projects[":id"].extensions
      .$put({ param: { id: projectId }, json: patch })
      .then((r) => ok<Extensions>(r))
      .catch(() => null);
    if (next) setExt(next);
  }
  const shared = ext.skills.filter((s) => !s.own);
  const servers = ext.mcp.filter((s) => s.installed);
  const toggleSkill = (name: string, on: boolean) => void save({ skills: shared.filter((s) => (s.name === name ? on : s.on)).map((s) => s.name) });
  const toggleServer = (id: string, on: boolean) => void save({ mcp: servers.filter((s) => (s.id === id ? on : s.on)).map((s) => s.id) });
  const toSettings = (
    <button type="button" className="link" onClick={() => navigate({ kind: "settings" })}>
      {t("projectParams.download")}
    </button>
  );

  return (
    <>
      <section className="params-block" aria-labelledby="params-skills-h">
        <h3 className="margin-h" id="params-skills-h">
          {t("skills.title")}
        </h3>
        {ext.skills.length === 0 && <p className="muted">{t("projectParams.noSkills")}</p>}
        {ext.skills.map((s) => (
          <Toggle key={`${s.own}-${s.name}`} checked={s.on} disabled={s.own} onChange={(on) => toggleSkill(s.name, on)}>
            <span title={s.description}>
              <span className="mono">{s.name}</span> {s.own && <span className="muted">{t("projectParams.ownSkill")}</span>}
            </span>
          </Toggle>
        ))}
        {toSettings}
      </section>
      <section className="params-block" aria-labelledby="params-mcp-h">
        <h3 className="margin-h" id="params-mcp-h">
          {t("mcp.title")}
        </h3>
        {servers.length === 0 && <p className="muted">{t("projectParams.noMcp")}</p>}
        {servers.map((s) => (
          <Toggle key={s.id} checked={s.on} onChange={(on) => toggleServer(s.id, on)}>
            <span className="mono">{s.name}</span>
          </Toggle>
        ))}
        {toSettings}
      </section>
    </>
  );
}
