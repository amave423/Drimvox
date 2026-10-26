import type { ProjectWorkView } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { fromShown, shownSign, toShown } from "../../lib/format";
import { PlanDetails } from "./PlanDetails";

/** A long project needs more than one task's budget: at least this much, in dollars, unless the settings say more. */
const MIN_BUDGET_USD = 1;
const DEFAULT_HOURS = 2;

/**
 * The plan the user reads before the work starts (docs/specs/project-work.md): what we build, the steps, the budget and
 * the time, "Go", or corrections the plan's model writes in.
 */
export function PlanCard({ work, onChanged }: { work: ProjectWorkView; onChanged(): void }) {
  const { api, t, settings, navigate, reloadChats } = useApp();
  const plan = work.plan;
  const [budget, setBudget] = useState(() => String(toShown(Math.max(work.startedAt ? work.budgetUsd : settings.agentBudgetUsd, MIN_BUDGET_USD))));
  const [hours, setHours] = useState(() => String(work.startedAt ? work.hours : DEFAULT_HOURS));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!plan) return null;
  const budgetUsd = fromShown(Number(budget.replace(",", ".")));
  const hoursValue = Number(hours.replace(",", "."));
  const valid = budgetUsd >= 0.01 && hoursValue >= 0.1;

  async function go() {
    setBusy(true);
    setFailed(null);
    const res = await api.projects[":id"].work.start.$post({ param: { id: work.projectId }, json: { budgetUsd, hours: hoursValue } }).catch(() => null);
    setBusy(false);
    const body = (await res?.json().catch(() => null)) as { chatId?: string; error?: { code?: string } } | null;
    if (!res?.ok || !body?.chatId) return setFailed(body?.error?.code ?? "unknown");
    await reloadChats();
    // The work goes on in the project's workshop: there already, or brought there from the interview's page.
    navigate({ kind: "project", projectId: work.projectId });
    onChanged();
  }

  async function revise() {
    if (!note.trim()) return;
    setBusy(true);
    setFailed(null);
    const res = await api.projects[":id"].work.revise.$post({ param: { id: work.projectId }, json: { note: note.trim() } }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setFailed("unknown");
    setNote("");
    onChanged();
  }

  return (
    <section className="project-plan" aria-label={t("projectWork.planTitle")}>
      <h2 className="sheet-h">{t("projectWork.planTitle")}</h2>
      <PlanDetails plan={plan} />
      <div className="plan-limits">
        <label className="field">
          <span className="field-label">{t("projectWork.budget", { currency: shownSign() })}</span>
          <input className="field-input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t("projectWork.hours")}</span>
          <input className="field-input" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
        </label>
      </div>
      <p className="muted">{t("projectWork.limitsHint")}</p>
      <div className="actions">
        <button className="btn is-primary" disabled={busy || !valid || work.status !== "ready"} onClick={() => void go()}>
          {t("projectWork.go")}
        </button>
      </div>
      <form
        className="plan-revise"
        onSubmit={(e) => {
          e.preventDefault();
          void revise();
        }}
      >
        <label className="field">
          <span className="field-label">{t("projectWork.reviseLabel")}</span>
          <textarea className="field-input" rows={3} value={note} placeholder={t("projectWork.revisePlaceholder")} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button className="btn" disabled={busy || !note.trim() || work.status !== "ready"}>
          {t("projectWork.revise")}
        </button>
      </form>
      {work.status === "planning" && <p className="muted">{t("projectWork.rewriting")}</p>}
      {failed && <p className="error-note">{t(`projectWork.error.${failed}` as MessageKey)}</p>}
    </section>
  );
}
