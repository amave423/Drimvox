import { useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";

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
