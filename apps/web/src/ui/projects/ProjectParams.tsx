import type { McpServerView, ProjectView, ProjectWorkView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { useBoxPrefs } from "../../lib/boxPrefs";
import { CATALOG } from "../../lib/catalog";
import type { ModelChoice } from "../../lib/lastModel";
import { useEntryText } from "../catalog/CatalogDetails";
import { ModelPicker } from "../chat/ModelPicker";
import { ThinkingSwitch } from "../chat/ThinkingSwitch";
import { Toggle } from "../Toggle";
import { GithubPublish } from "./GithubPublish";
import { LimitsForm } from "./LimitsForm";
import { PublishSiteCard } from "./Workspace";

interface Extensions {
  skills: { name: string; description: string; own: boolean; on: boolean }[];
  mcp: { id: string; name: string; on: boolean; installed: boolean }[];
  vision: ModelChoice | null;
  service: ModelChoice | null;
}
type ExtensionsPatch = { skills?: string[]; mcp?: string[]; vision?: ModelChoice | null; service?: ModelChoice | null };
const refOf = (m: ModelChoice | null) => (m ? { providerId: m.providerId, model: m.model } : null);

/**
 * A project's parameters, in the lower window on the right (asked for: they were a pop-up under the box and a tab of
 * things not about the project): how the work goes, the skills and MCP servers this project uses of the installed ones,
 * and where it is published.
 */
export function ProjectParams({ project, work }: { project: ProjectView; work: ProjectWorkView | null }) {
  const { api, t, reloadWorks } = useApp();
  const [ext, setExt] = useState<Extensions | null>(null);
  useEffect(() => {
    void api.projects[":id"].extensions
      .$get({ param: { id: project.id } })
      .then((r) => ok<Extensions>(r))
      .then(setExt)
      .catch(() => setExt(null));
  }, [api, project.id]);
  async function save(patch: ExtensionsPatch) {
    const next = await api.projects[":id"].extensions
      .$put({ param: { id: project.id }, json: patch })
      .then((r) => ok<Extensions>(r))
      .catch(() => null);
    if (next) setExt(next);
  }
  return (
    <div className="project-params">
      <WorkOptions
        projectId={project.id}
        vision={ext?.vision ?? null}
        onVision={(m) => void save({ vision: refOf(m) })}
        service={ext?.service ?? null}
        onService={(m) => void save({ service: refOf(m) })}
      />
      {work && (
        <section className="params-block" aria-labelledby="params-limits-h">
          <h3 className="margin-h" id="params-limits-h">
            {t("projectParams.limits")}
          </h3>
          <LimitsForm key={`${work.projectId}-${work.budgetUsd}-${work.hours}`} work={work} onSaved={reloadWorks} />
        </section>
      )}
      {ext && <ProjectExtensions ext={ext} save={save} />}
      {project.gitState === "ready" && (
        // GitHub and the site, each under its own heading; one name for both for those who read the page by regions.
        <section className="params-block params-publish" aria-label={t("projectParams.publish")}>
          <GithubPublish project={project} />
          {work?.startedAt && work.status !== "running" && <PublishSiteCard projectId={project.id} />}
        </section>
      )}
    </div>
  );
}

/**
 * Whether an interview and a plan come first and their models, the strong model, the model for screenshots, the
 * thinking (useBoxPrefs; the screenshots' model is kept by the core). A model left unchosen is the working one: the
 * button says so, and "As the working one" beside a chosen model puts it back.
 */
function WorkOptions(p: {
  projectId: string;
  vision: ModelChoice | null;
  onVision(m: ModelChoice | null): void;
  service: ModelChoice | null;
  onService(m: ModelChoice | null): void;
}) {
  const { projectId } = p;
  const { t } = useApp();
  const [prefs, set] = useBoxPrefs(projectId);
  const asWorking = (value: ModelChoice | null, change: (m: ModelChoice | null) => void) => (
    <span className="options-model">
      <ModelPicker value={value} onChange={change} placement="above" empty={t("projectBox.asWorking")} />
      {value && (
        <button type="button" className="link" onClick={() => change(null)}>
          {t("projectBox.asWorking")}
        </button>
      )}
    </span>
  );
  const strongOn = prefs.strongOn || !!prefs.strong;
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
      {prefs.interview && (
        <div className="params-row is-model">
          <span className="muted">{t("projectBox.interviewModel")}</span>
          {asWorking(prefs.interviewModel, (interviewModel) => set({ interviewModel }))}
        </div>
      )}
      <Toggle checked={prefs.plan} onChange={(plan) => set({ plan })}>
        <span>
          {t("projectBox.plan")} <span className="options-about">{t("projectBox.planHint")}</span>
        </span>
      </Toggle>
      {prefs.plan && (
        <div className="params-row is-model">
          <span className="muted">{t("projectBox.planModel")}</span>
          {asWorking(prefs.planModel, (planModel) => set({ planModel }))}
        </div>
      )}
      <Toggle checked={strongOn} onChange={(on) => set(on ? { strongOn: true } : { strongOn: false, strong: null })}>
        <span>
          {t("projectBox.strong")} <span className="options-about">{t("projectBox.strongHint")}</span>
        </span>
      </Toggle>
      {strongOn && (
        <div className="params-row is-model">
          <ModelPicker value={prefs.strong} onChange={(strong) => set({ strong })} placement="above" />
        </div>
      )}
      {/* Switches as the strong model's (asked for): off, the working model does it. */}
      <ModelSwitch label={t("projectParams.vision")} hint={t("projectParams.visionHint")} value={p.vision} onChange={p.onVision} vision />
      <ModelSwitch label={t("projectParams.service")} hint={t("projectParams.serviceHint")} value={p.service} onChange={p.onService} />
      <div className="params-row">
        <span className="muted">{t("thinking.label")}</span>
        <ThinkingSwitch value={prefs.thinking} onChange={(thinking) => set({ thinking })} />
      </div>
    </section>
  );
}

/** A model the project may choose for one job: a switch with its hint, the picker once it is on. */
function ModelSwitch(p: { label: string; hint: string; value: ModelChoice | null; onChange(m: ModelChoice | null): void; vision?: boolean }) {
  const [chosen, setChosen] = useState(false);
  const on = chosen || !!p.value;
  return (
    <>
      <Toggle checked={on} onChange={(next) => (next ? setChosen(true) : (setChosen(false), p.onChange(null)))}>
        <span>
          {p.label} <span className="options-about">{p.hint}</span>
        </span>
      </Toggle>
      {on && (
        <div className="params-row is-model">
          <ModelPicker value={p.value} onChange={p.onChange} placement="above" vision={p.vision} />
        </div>
      )}
    </>
  );
}

/**
 * The installed skills and MCP servers this project uses (asked for: switched on per project), named as the settings'
 * cards name them, with their author.
 */
function ProjectExtensions({ ext, save }: { ext: Extensions; save(patch: ExtensionsPatch): Promise<void> }) {
  const { api, t, navigate } = useApp();
  const text = useEntryText();
  const [servers, setServers] = useState<McpServerView[]>([]);
  useEffect(() => {
    void api.mcp
      .$get()
      .then((r) => ok<McpServerView[]>(r))
      .then(setServers)
      .catch(() => setServers([]));
  }, [api]);
  const skillEntry = (name: string) => CATALOG.find((e) => e.kind === "skill" && e.skill === name);
  const serverEntry = (id: string) => {
    const server = servers.find((s) => s.id === id);
    return server ? CATALOG.find((e) => e.kind === "mcp" && e.matches(server)) : undefined;
  };
  const shared = ext.skills.filter((s) => !s.own);
  const installed = ext.mcp.filter((s) => s.installed);
  const toggleSkill = (name: string, on: boolean) => void save({ skills: shared.filter((s) => (s.name === name ? on : s.on)).map((s) => s.name) });
  const toggleServer = (id: string, on: boolean) => void save({ mcp: installed.filter((s) => (s.id === id ? on : s.on)).map((s) => s.id) });
  const toSettings = (
    <button type="button" className="link" onClick={() => navigate({ kind: "settings" })}>
      {t("projectParams.download")}
    </button>
  );
  const named = (name: string, vendor: string | null, about?: string) => (
    <span className="ext-name" title={about}>
      <span>{name}</span>
      {vendor && <span className="muted">{vendor}</span>}
    </span>
  );

  return (
    <>
      <section className="params-block" aria-labelledby="params-skills-h">
        <h3 className="margin-h" id="params-skills-h">
          {t("skills.title")}
        </h3>
        {ext.skills.length === 0 && <p className="muted">{t("projectParams.noSkills")}</p>}
        {ext.skills.map((s) => {
          const entry = s.own ? undefined : skillEntry(s.name);
          return (
            <Toggle key={`${s.own}-${s.name}`} checked={s.on} disabled={s.own} onChange={(on) => toggleSkill(s.name, on)}>
              {named(entry ? text(entry, "name") : s.name, s.own ? t("projectParams.ownSkill") : (entry?.vendor ?? null), s.description)}
            </Toggle>
          );
        })}
        {toSettings}
      </section>
      <section className="params-block" aria-labelledby="params-mcp-h">
        <h3 className="margin-h" id="params-mcp-h">
          {t("mcp.title")}
        </h3>
        {installed.length === 0 && <p className="muted">{t("projectParams.noMcp")}</p>}
        {installed.map((s) => {
          const entry = serverEntry(s.id);
          return (
            <Toggle key={s.id} checked={s.on} onChange={(on) => toggleServer(s.id, on)}>
              {named(entry ? text(entry, "name") : s.name, entry?.vendor ?? null)}
            </Toggle>
          );
        })}
        {toSettings}
      </section>
    </>
  );
}
