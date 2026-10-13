import type { TaskView } from "@artel/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";

type Choice = { kind: "option"; index: number } | { kind: "custom"; text: string };

/**
 * One round of the agent's questions: open ones get a text field, the rest are options with a recommended one
 * or the user's own answer. Above them, what the agent understood so far and what it still does not know.
 */
export function Interview({ task }: { task: TaskView }) {
  const { api, t } = useApp();
  const initial = () =>
    Object.fromEntries(
      task.questions.map((q): [string, Choice] =>
        q.options.length > 0 && q.recommended !== null ? [q.id, { kind: "option", index: q.recommended }] : [q.id, { kind: "custom", text: "" }],
      ),
    );
  const [choices, setChoices] = useState<Record<string, Choice>>(initial);
  const [busy, setBusy] = useState(false);
  // A new round brings new questions.
  useEffect(() => setChoices(initial()), [task.interview?.round, task.questions.map((q) => q.id).join()]);

  const answerOf = (id: string): string | null => {
    const c = choices[id];
    const q = task.questions.find((x) => x.id === id);
    if (!c || !q) return null;
    if (c.kind === "custom") return c.text.trim() || null;
    const o = q.options[c.index];
    return o ? (o.description ? `${o.label} (${o.description})` : o.label) : null;
  };
  const answered = task.questions.flatMap((q) => {
    const answer = answerOf(q.id);
    return answer ? [{ id: q.id, answer }] : [];
  });
  const complete = answered.length === task.questions.length;

  async function send(enough: boolean) {
    setBusy(true);
    await api.tasks[":id"].answers.$post({ param: { id: task.id }, json: { answers: answered, enough } }).catch(() => null);
    setBusy(false);
  }

  const state = task.interview;
  return (
    <section className="interview">
      <h2 className="sheet-h">{t("interview.title")}</h2>
      <p className="muted">
        {state ? `${t("interview.round", { round: state.round, max: state.maxRounds })} · ` : ""}
        {t("interview.lede")}
      </p>
      {state && (state.understood || state.unknown.length > 0) && (
        <div className="interview-notes">
          {state.understood && (
            <div>
              <h3 className="spec-sub">{t("interview.understood")}</h3>
              <p>{state.understood}</p>
            </div>
          )}
          {state.unknown.length > 0 && (
            <div>
              <h3 className="spec-sub">{t("interview.unknown")}</h3>
              <ul>
                {state.unknown.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {task.questions.map((q) => {
        const c = choices[q.id];
        if (q.options.length === 0) {
          return (
            <fieldset key={q.id} className="question">
              <legend>{q.question}</legend>
              <textarea
                className="field-input"
                rows={3}
                placeholder={t("interview.openPlaceholder")}
                aria-label={q.question}
                value={c?.kind === "custom" ? c.text : ""}
                onChange={(e) => setChoices({ ...choices, [q.id]: { kind: "custom", text: e.target.value } })}
              />
            </fieldset>
          );
        }
        return (
          <fieldset key={q.id} className="question">
            <legend>{q.question}</legend>
            {q.options.map((o, i) => (
              <label key={i} className={`option${c?.kind === "option" && c.index === i ? " is-on" : ""}`}>
                <input
                  type="radio"
                  name={`q-${q.id}`}
                  checked={c?.kind === "option" && c.index === i}
                  onChange={() => setChoices({ ...choices, [q.id]: { kind: "option", index: i } })}
                />
                <span className="option-text">
                  <span>{o.label}</span>
                  {o.description && <small>{o.description}</small>}
                </span>
                {q.recommended === i && <span className="option-rec">{t("interview.recommended")}</span>}
              </label>
            ))}
            <label className={`option is-custom${c?.kind === "custom" ? " is-on" : ""}`}>
              <input
                type="radio"
                name={`q-${q.id}`}
                checked={c?.kind === "custom"}
                onChange={() => setChoices({ ...choices, [q.id]: { kind: "custom", text: c?.kind === "custom" ? c.text : "" } })}
              />
              <span className="option-text">
                <span>{t("interview.custom")}</span>
                {c?.kind === "custom" && (
                  <input
                    className="field-input"
                    autoFocus
                    placeholder={t("interview.customPlaceholder")}
                    aria-label={`${q.question} — ${t("interview.custom")}`}
                    value={c.text}
                    onChange={(e) => setChoices({ ...choices, [q.id]: { kind: "custom", text: e.target.value } })}
                  />
                )}
              </span>
            </label>
          </fieldset>
        );
      })}
      <div className="actions">
        <button className="btn is-primary" disabled={busy || !complete} onClick={() => void send(false)}>
          {t("interview.send")}
        </button>
        <button className="btn" disabled={busy} onClick={() => void send(true)} title={t("interview.enoughHint")}>
          {t("interview.enough")}
        </button>
      </div>
      <p className="muted interview-hint">{t("interview.enoughHint")}</p>
    </section>
  );
}
