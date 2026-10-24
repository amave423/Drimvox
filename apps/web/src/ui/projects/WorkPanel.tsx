import type { ProjectWorkView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { formatUsd, fromShown, shownSign, toShown } from "../../lib/format";
import { WorkState } from "./ProjectWork";
import { hoursAndMinutes } from "./useProjectWork";
import { SiteCard } from "./Workspace";

/**
 * Next to a project's conversation (docs/specs/project-work.md): how the run goes, the agent's checklist, the time, money
 * and actions with the limits to change on the way, the agent's questions, and the started result. The actions and the
 * screenshots are in the conversation, where they happened (seen: a separate log on the right said nothing).
 */
export function WorkPanel({ work, onChanged }: { work: ProjectWorkView; onChanged(): void }) {
  const { api, t } = useApp();
  const [budget, setBudget] = useState(() => String(toShown(work.budgetUsd)));
  const [hours, setHours] = useState(() => String(work.hours));
  // The limits typed here stay until saved; the server's change them only when nobody is typing.
  useEffect(() => setBudget(String(toShown(work.budgetUsd))), [work.budgetUsd]);
  useEffect(() => setHours(String(work.hours)), [work.hours]);

  const changedLimits = fromShown(Number(budget.replace(",", "."))) !== work.budgetUsd || Number(hours.replace(",", ".")) !== work.hours;

  async function saveLimits() {
    const budgetUsd = fromShown(Number(budget.replace(",", ".")));
    const h = Number(hours.replace(",", "."));
    if (!(budgetUsd >= 0.01) || !(h >= 0.1)) return;
    await api.projects[":id"].work.$patch({ param: { id: work.projectId }, json: { budgetUsd, hours: h } }).catch(() => null);
    onChanged();
  }

  async function act(kind: "stop" | "continue") {
    await (kind === "stop" ? api.projects[":id"].work.stop.$post({ param: { id: work.projectId } }) : api.projects[":id"].work.continue.$post({ param: { id: work.projectId } })).catch(() => null);
    onChanged();
  }

  return (
    <aside className="margin work-panel" aria-label={t("projectWork.panel")}>
      <div className="note">
        <WorkState work={work} />
        {work.escalated && <p className="muted">{t("projectWork.escalated")}</p>}
        <div className="actions">
          {work.status === "running" ? (
            <button className="btn is-pencil" onClick={() => void act("stop")}>
              {t("projectWork.stop")}
            </button>
          ) : (
            work.status !== "done" && (
              <button className="btn is-primary" onClick={() => void act("continue")}>
                {t("projectWork.continue")}
              </button>
            )
          )}
        </div>
      </div>

      <SiteCard work={work} onChanged={onChanged} />

      {work.checklist.length > 0 && (
        <section className="note">
          <h3 className="margin-h">
            {t("projectWork.checklist")} <span className="muted">{t("projectWork.progress", { done: work.checklist.filter((i) => i.done).length, total: work.checklist.length })}</span>
          </h3>
          <ul className="checklist">
            {work.checklist.map((item, n) => (
              <li key={n} className={item.done ? "is-done" : undefined}>
                <span className="check-mark" aria-hidden>
                  {item.done ? "✓" : ""}
                </span>
                <span className="visually-hidden">{item.done ? t("projectWork.itemDone") : t("projectWork.itemOpen")}</span>
                {item.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="note work-numbers">
        <dl>
          <dt>{t("projectWork.time")}</dt>
          <dd className="mono">
            {hoursAndMinutes(work.workedMs, t)} / {t("projectWork.hoursShort", { h: work.hours })}
          </dd>
          <dt>{t("projectWork.spent")}</dt>
          <dd className="mono">
            {formatUsd(work.spentUsd)} / {formatUsd(work.budgetUsd)}
          </dd>
          <dt>{t("projectWork.actions")}</dt>
          <dd className="mono">{work.actions}</dd>
        </dl>
        <form
          className="work-limits"
          onSubmit={(e) => {
            e.preventDefault();
            void saveLimits();
          }}
        >
          <label className="field">
            <span className="field-label">{t("projectWork.budget", { currency: shownSign() })}</span>
            <input className="field-input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">{t("projectWork.hours")}</span>
            <input className="field-input" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
          </label>
          {changedLimits && <button className="btn">{t("projectWork.save")}</button>}
        </form>
      </section>

      {work.questions.length > 0 && (
        <section className="note">
          <h3 className="margin-h">{t("projectWork.questions")}</h3>
          <ul className="work-questions">
            {work.questions.map((q, n) => (
              <li key={n}>
                <p>{q.question}</p>
                <p className="muted">{t("projectWork.assumes", { assumption: q.assumption })}</p>
              </li>
            ))}
          </ul>
          <p className="muted">{t("projectWork.answerHint")}</p>
        </section>
      )}
    </aside>
  );
}
