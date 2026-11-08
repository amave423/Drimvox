import type { ProjectWorkView } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { Markdown } from "../chat/Markdown";

/**
 * The plan the model proposed in the project's conversation, as Claude Code shows it (asked for): its text, "Go", and
 * the box below for changes. "Go" lets the same model go on in the same conversation with everything it read.
 */
export function ChatPlanCard({ work, onChanged }: { work: ProjectWorkView; onChanged(): void }) {
  const { api, t, reloadWorks } = useApp();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!work.plan) return null;

  async function go() {
    setBusy(true);
    setFailed(null);
    const res = await api.projects[":id"].work.start
      .$post({ param: { id: work.projectId }, json: { budgetUsd: work.budgetUsd, hours: work.hours } })
      .catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { code?: string } } | null;
      return setFailed(body?.error?.code ?? "unknown");
    }
    reloadWorks();
    onChanged();
  }

  return (
    <section className="chat-plan" aria-label={t("projectWork.planTitle")}>
      <h3 className="chat-plan-h">{t("projectWork.planTitle")}</h3>
      <Markdown text={work.plan.context} />
      <div className="actions">
        <button className="btn is-primary" disabled={busy || work.status !== "ready"} onClick={() => void go()}>
          {t("projectWork.go")}
        </button>
        <span className="muted">{t("planning.fixBelow")}</span>
      </div>
      {failed && <p className="error-note">{t(`projectWork.error.${failed}` as MessageKey)}</p>}
    </section>
  );
}
