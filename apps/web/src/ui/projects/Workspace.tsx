import type { DiffFile, ProjectWorkView } from "@drimvox/shared";
import { useCallback, useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { Markdown } from "../chat/Markdown";
import { Tabs } from "../Tabs";
import { DiffView } from "../tasks/DiffView";
import { PlanDetails } from "./PlanDetails";

export type WorkTab = "work" | "plan" | "changes" | "run";
const TABS: WorkTab[] = ["work", "plan", "changes", "run"];

/** The project workspace's tabs over the conversation (docs/specs/project-work.md): the work, the plan, the changes, the result. */
export function WorkTabs({ tab, onTab }: { tab: WorkTab; onTab(tab: WorkTab): void }) {
  const { t } = useApp();
  return <Tabs value={tab} label={t("projectWork.panel")} options={TABS.map((name) => ({ value: name, label: t(`projectWork.tab.${name}`) }))} onChange={onTab} />;
}

/** The plan the work follows, read only: corrections go to the agent as messages. */
export function PlanTab({ work }: { work: ProjectWorkView }) {
  const { t } = useApp();
  if (!work.plan) return <p className="muted">{t("projectWork.noPlan")}</p>;
  return (
    <section className="work-tab-body">
      <PlanDetails plan={work.plan} />
      <p className="muted">{t("projectWork.planChangeHint")}</p>
    </section>
  );
}

/** What the agent changed in the folder since the last commit; the user commits. */
export function ChangesTab({ work }: { work: ProjectWorkView }) {
  const { api, t } = useApp();
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const load = useCallback(async () => {
    const next = await api.projects[":id"].work.changes
      .$get({ param: { id: work.projectId } })
      .then((r) => ok<DiffFile[]>(r))
      .catch(() => null);
    setFiles(next ?? []);
  }, [api, work.projectId]);
  useEffect(() => void load(), [load]);
  // While the agent works the folder changes: the list follows it now and then.
  const running = work.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [running, load]);

  if (!files) return <p className="muted">{t("projectWork.changesLoading")}</p>;
  return (
    <section className="work-tab-body">
      <p className="muted">
        {files.length ? t("projectWork.changesCount", { n: files.length }) : t("projectWork.changesNone")} {t("projectWork.changesHint")}
      </p>
      {files.length > 0 && <DiffView files={files} comments={[]} />}
    </section>
  );
}

/** The agent's report and the result Drimvox started: where to open it, stop and start it again. */
export function RunTab({ work, onChanged }: { work: ProjectWorkView; onChanged(): void }) {
  const { t } = useApp();
  return (
    <section className="work-tab-body">
      <SiteCard work={work} onChanged={onChanged} />
      {work.report ? (
        <div className="note work-report">
          <h3 className="margin-h">{t("projectWork.report")}</h3>
          <Markdown text={work.report} />
        </div>
      ) : (
        !work.site && <p className="muted">{t(work.status === "running" ? "projectWork.runLater" : "projectWork.runNone")}</p>
      )}
    </section>
  );
}

/** The finished project, running while Drimvox runs (in the tray too): open it, stop it, start it again. */
export function SiteCard({ work, onChanged }: { work: ProjectWorkView; onChanged(): void }) {
  const { api, t } = useApp();
  const [busy, setBusy] = useState(false);
  if (!work.site) return null;
  async function act(kind: "start" | "stop") {
    setBusy(true);
    const site = api.projects[":id"].work.site;
    await (kind === "start" ? site.start.$post({ param: { id: work.projectId } }) : site.stop.$post({ param: { id: work.projectId } })).catch(() => null);
    setBusy(false);
    onChanged();
  }
  const running = work.site.running;
  return (
    <div className="note work-site">
      <p className={running ? "work-state is-ok" : "work-state"}>{t(running ? "projectWork.siteRunning" : "projectWork.siteStopped")}</p>
      <p className="mono work-site-url">{work.site.url}</p>
      <div className="actions">
        {running && (
          <a className="btn is-primary" href={work.site.url} target="_blank" rel="noreferrer">
            {t("projectWork.siteOpen")}
          </a>
        )}
        <button className={running ? "btn" : "btn is-primary"} disabled={busy || work.status === "running"} onClick={() => void act(running ? "stop" : "start")}>
          {t(running ? "projectWork.siteStop" : "projectWork.siteStart")}
        </button>
      </div>
    </div>
  );
}
