import type { ProjectWorkView } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";
import { fromShown, shownSign, toShown } from "../../lib/format";

/** The run's budget and time, changed on the way; opens from the numbers in the workshop's header. */
export function LimitsForm({ work, onSaved }: { work: ProjectWorkView; onSaved(): void }) {
  const { api, t } = useApp();
  const [budget, setBudget] = useState(() => String(toShown(work.budgetUsd)));
  const [hours, setHours] = useState(() => String(work.hours));
  const budgetUsd = fromShown(Number(budget.replace(",", ".")));
  const h = Number(hours.replace(",", "."));
  const valid = budgetUsd >= 0.01 && h >= 0.1;

  async function save() {
    if (!valid) return;
    await api.projects[":id"].work.$patch({ param: { id: work.projectId }, json: { budgetUsd, hours: h } }).catch(() => null);
    onSaved();
  }

  return (
    <form
      className="workshop-limits"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="field">
        <span className="field-label">{t("projectWork.budget", { currency: shownSign() })}</span>
        <input className="field-input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span className="field-label">{t("projectWork.hours")}</span>
        <input className="field-input" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
      </label>
      <button className="btn is-primary" disabled={!valid}>
        {t("projectWork.save")}
      </button>
      <p className="muted">{t("projectWork.limitsHint")}</p>
    </form>
  );
}
