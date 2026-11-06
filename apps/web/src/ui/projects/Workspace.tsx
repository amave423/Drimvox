import type { ProjectWorkView } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { Markdown } from "../chat/Markdown";

/**
 * What came of the work, as a card at the end of the project's conversation: the agent's own report. Without the started
 * result's card and the run's figures (asked for: not needed there).
 */
export function WorkResultCard({ work }: { work: ProjectWorkView }) {
  const { t } = useApp();
  return (
    <section className="work-result-card" aria-label={t("workshop.result")}>
      {work.escalated && <p className="muted">{t("projectWork.escalated")}</p>}
      <div className="note work-report">
        <h3 className="margin-h">{t("projectWork.report")}</h3>
        <Markdown text={work.report ?? ""} />
      </div>
    </section>
  );
}

/**
 * The finished site on the internet in one click (asked for): built if it has a build, put on GitHub Pages from a branch
 * of its own, with the link. The project must be on GitHub first.
 */
export function PublishSiteCard({ projectId }: { projectId: string }) {
  const { api, t } = useApp();
  const [state, setState] = useState<{ kind: "idle" | "busy" } | { kind: "done"; url: string } | { kind: "failed"; code: string; detail?: string }>({
    kind: "idle",
  });
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
      {state.kind === "failed" && (
        <p className="is-pencil-text">
          {t(`publish.error.${["no_remote", "github_login", "no_site", "push_failed"].includes(state.code) ? state.code : "other"}` as MessageKey, {
            detail: state.detail ?? "",
          })}
        </p>
      )}
      <div className="actions">
        <button className="btn is-primary" disabled={state.kind === "busy"} onClick={() => void publish()}>
          {state.kind === "busy" ? t("publish.busy") : state.kind === "done" ? t("publish.again") : t("publish.go")}
        </button>
      </div>
    </div>
  );
}
