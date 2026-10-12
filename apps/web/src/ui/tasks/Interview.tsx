import type { TaskView } from "@artel/shared";
import { useState } from "react";
import { useApp } from "../../context";

type Choice = { kind: "option"; index: number } | { kind: "custom"; text: string };

/** The agent's questions as cards: options with a recommended one, or the user's own answer. */
export function Interview({ task }: { task: TaskView }) {
  const { api, t } = useApp();
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(task.questions.filter((q) => q.recommended !== null).map((q) => [q.id, { kind: "option", index: q.recommended! }])),
  );
  const [busy, setBusy] = useState(false);

  const answerOf = (id: string): string | null => {
    const c = choices[id];
    const q = task.questions.find((x) => x.id === id);
    if (!c || !q) return null;
    if (c.kind === "custom") return c.text.trim() || null;
    const o = q.options[c.index];
    return o ? (o.description ? `${o.label} (${o.description})` : o.label) : null;
  };
  const complete = task.questions.every((q) => answerOf(q.id) !== null);

  async function send(skip: boolean) {
    setBusy(true);
    const answers = skip ? [] : task.questions.map((q) => ({ id: q.id, answer: answerOf(q.id)! }));
    await api.tasks[":id"].answers.$post({ param: { id: task.id }, json: { answers, skip } }).catch(() => null);
    setBusy(false);
  }

  return (
    <section className="interview">
      <h2 className="sheet-h">{t("interview.title")}</h2>
      <p className="muted">{t("interview.lede")}</p>
      {task.questions.map((q) => {
        const c = choices[q.id];
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
        <button className="btn" disabled={busy} onClick={() => void send(true)}>
          {t("interview.skip")}
        </button>
      </div>
    </section>
  );
}
