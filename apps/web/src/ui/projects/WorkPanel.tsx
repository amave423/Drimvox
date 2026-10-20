import type { MessageView, ProjectWorkView } from "@artel/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { formatUsd, fromShown, shownSign, toShown } from "../../lib/format";
import { useAuthorizedUrl } from "../../lib/media";
import { WorkState } from "./ProjectWork";
import { hoursAndMinutes } from "./useProjectWork";

/** Actions the log shows before "the whole log". */
const LOG_SHOWN = 8;

/**
 * Next to a project's conversation (docs/specs/project-work.md): how the run goes, the agent's checklist, the time, money
 * and actions with the limits to change on the way, the agent's questions, the screenshots and the log of actions.
 */
export function WorkPanel({
  work,
  messages,
  line,
  onChanged,
}: {
  work: ProjectWorkView;
  messages: MessageView[];
  /** How an action reads in the log. */
  line(name: string, input: string): string;
  onChanged(): void;
}) {
  const { api, t, token } = useApp();
  const [budget, setBudget] = useState(() => String(toShown(work.budgetUsd)));
  const [hours, setHours] = useState(() => String(work.hours));
  const [allLog, setAllLog] = useState(false);
  const [big, setBig] = useState<string | null>(null);
  // The limits typed here stay until saved; the server's change them only when nobody is typing.
  useEffect(() => setBudget(String(toShown(work.budgetUsd))), [work.budgetUsd]);
  useEffect(() => setHours(String(work.hours)), [work.hours]);

  const changedLimits = fromShown(Number(budget.replace(",", "."))) !== work.budgetUsd || Number(hours.replace(",", ".")) !== work.hours;
  const log = messages.filter((m) => m.role === "assistant").flatMap((m) => m.activity);
  const shown = allLog ? log : log.slice(-LOG_SHOWN);
  const shotUrl = (id: string) => `/api/projects/${work.projectId}/work/shots/${id}`;

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

      {work.shots.length > 0 && (
        <section className="note">
          <h3 className="margin-h">{t("projectWork.shots")}</h3>
          <div className="work-shots">
            {work.shots
              .slice(-6)
              .reverse()
              .map((s) => (
                <button key={s.id} className="work-shot" title={s.url} onClick={() => setBig(s.id)}>
                  <Shot url={shotUrl(s.id)} token={token} alt={s.url} />
                </button>
              ))}
          </div>
        </section>
      )}

      {log.length > 0 && (
        <section className="note">
          <h3 className="margin-h">{t("projectWork.log")}</h3>
          <ol className="work-log muted">
            {shown.map((a, n) => (
              <li key={n}>{line(a.name, a.input)}</li>
            ))}
          </ol>
          {log.length > LOG_SHOWN && (
            <button className="link" onClick={() => setAllLog(!allLog)}>
              {allLog ? t("projectWork.logLess") : t("projectWork.logAll", { n: log.length })}
            </button>
          )}
        </section>
      )}

      {big && (
        <div className="shot-view" role="dialog" aria-label={t("projectWork.shots")} onClick={() => setBig(null)}>
          <Shot url={shotUrl(big)} token={token} alt="" />
        </div>
      )}
    </aside>
  );
}

/** A screenshot comes from the core with the token, which an <img> cannot send. */
function Shot({ url, token, alt }: { url: string; token: string | null; alt: string }) {
  const src = useAuthorizedUrl(url, token);
  return src ? <img src={src} alt={alt} /> : <span className="work-shot-empty" aria-hidden />;
}
