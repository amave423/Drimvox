import type { DiffFile, ProjectWorkView, WorkReport } from "@drimvox/shared";
import { useCallback, useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { formatUsd } from "../../lib/format";
import { activityLine } from "../chat/activityLine";
import { Markdown } from "../chat/Markdown";
import { hoursAndMinutes } from "./useProjectWork";
import { DiffView } from "../tasks/DiffView";
import { PlanDetails } from "./PlanDetails";

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
      {work.startedAt && work.status !== "running" && <PublishSiteCard projectId={work.projectId} />}
      {work.startedAt && work.status !== "running" && <ReportCard work={work} />}
    </section>
  );
}

/**
 * The finished site on the internet in one click (asked for): built if it has a build, put on GitHub Pages from a branch
 * of its own, with the link. The project must be on GitHub first.
 */
function PublishSiteCard({ projectId }: { projectId: string }) {
  const { api, t } = useApp();
  const [state, setState] = useState<{ kind: "idle" | "busy" } | { kind: "done"; url: string } | { kind: "failed"; code: string; detail?: string }>({ kind: "idle" });
  async function publish() {
    setState({ kind: "busy" });
    const res = await api.github.projects[":id"].site.$post({ param: { id: projectId } }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { url?: string; error?: { code?: string; detail?: string } } | null;
    if (res?.ok && body?.url) setState({ kind: "done", url: body.url });
    else setState({ kind: "failed", code: body?.error?.code ?? "unknown", detail: body?.error?.detail });
  }
  return (
    <div className="note work-publish">
      <h3 className="margin-h">{t("publish.title")}</h3>
      <p className="muted">{t("publish.hint")}</p>
      {state.kind === "done" && (
        <p>
          {t("publish.done")}{" "}
          <a href={state.url} target="_blank" rel="noreferrer" className="mono">
            {state.url}
          </a>
        </p>
      )}
      {state.kind === "failed" && <p className="is-pencil-text">{t(`publish.error.${["no_remote", "github_login", "no_site", "push_failed"].includes(state.code) ? state.code : "other"}` as MessageKey, { detail: state.detail ?? "" })}</p>}
      <div className="actions">
        <button className="btn is-primary" disabled={state.kind === "busy"} onClick={() => void publish()}>
          {state.kind === "busy" ? t("publish.busy") : state.kind === "done" ? t("publish.again") : t("publish.go")}
        </button>
      </div>
    </div>
  );
}

/** What the run did (asked for: a report after the project): time, money by model, actions by kind, files, checklist. */
function ReportCard({ work }: { work: ProjectWorkView }) {
  const { api, t } = useApp();
  const [report, setReport] = useState<WorkReport | null>(null);
  useEffect(() => {
    void api.projects[":id"].work.report
      .$get({ param: { id: work.projectId } })
      .then((r) => ok<WorkReport>(r))
      .then(setReport)
      .catch(() => setReport(null));
  }, [api, work.projectId, work.status]);
  if (!report) return null;
  const top = report.actions.slice(0, 6);
  return (
    <div className="note work-stats">
      <h3 className="margin-h">{t("projectWork.stats")}</h3>
      <dl className="work-stats-grid">
        <dt>{t("projectWork.time")}</dt>
        <dd className="mono">{hoursAndMinutes(report.workedMs, t)}</dd>
        <dt>{t("projectWork.spent")}</dt>
        <dd className="mono">{formatUsd(report.costUsd)}</dd>
        <dt>{t("projectWork.statsTokens")}</dt>
        <dd className="mono">
          {report.inputTokens.toLocaleString()} → {report.outputTokens.toLocaleString()}
        </dd>
        <dt>{t("projectWork.checklist")}</dt>
        <dd className="mono">{t("projectWork.progress", { done: report.checklist.done, total: report.checklist.total })}</dd>
        <dt>{t("projectWork.statsFiles")}</dt>
        <dd className="mono">
          {report.files.changed} · <span className="is-ok-text">+{report.files.added}</span> <span className="is-pencil-text">−{report.files.removed}</span>
        </dd>
      </dl>
      {report.byModel.length > 0 && (
        <>
          <h4>{t("projectWork.statsModels")}</h4>
          <ul className="work-stats-list">
            {report.byModel.map((m) => (
              <li key={m.model}>
                <span className="mono">{m.model}</span>
                <span className="muted">{t("spending.answers", { n: m.answers })}</span>
                <span className="mono">{formatUsd(m.costUsd)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {top.length > 0 && (
        <>
          <h4>{t("projectWork.statsActions")}</h4>
          <ul className="work-stats-list">
            {top.map((a) => (
              <li key={a.name}>
                <span>{activityLine(t, a.name, "").replace(/[:\s]+$/, "")}</span>
                <span className="mono">{a.count}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
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
