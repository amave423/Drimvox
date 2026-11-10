import type { ChatQuestionView } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";

/**
 * The agent's questions, as OpenCode asks them (asked for: instead of the interview and plan switches): each with a few
 * answers to pick, the recommended one first, and a field for the user's own words. A message written in the box below
 * answers them too.
 */
export function QuestionCard({ card, onAnswer }: { card: ChatQuestionView; onAnswer(id: string, answers: string[]): Promise<void> }) {
  const { t } = useApp();
  const [picked, setPicked] = useState<string[][]>(() => card.questions.map(() => []));
  const [own, setOwn] = useState<string[]>(() => card.questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const answers = card.questions.map((_, i) => [...picked[i]!, own[i]!.trim()].filter(Boolean).join("; "));
  const ready = answers.every(Boolean);

  function pick(i: number, label: string, multiple: boolean) {
    setPicked((all) => all.map((p, j) => (j !== i ? p : multiple ? (p.includes(label) ? p.filter((l) => l !== label) : [...p, label]) : p[0] === label ? [] : [label])));
  }

  async function send() {
    setBusy(true);
    await onAnswer(card.id, answers);
    setBusy(false);
  }

  return (
    <div className="approval agent-question-card" role="alert">
      <strong>{t("question.title")}</strong>
      {card.questions.map((q, i) => (
        <fieldset key={i} className="agent-question">
          <legend>
            {q.header && <span className="agent-question-header">{q.header}</span>}
            {q.question}
          </legend>
          <div className="agent-question-options">
            {q.options.map((o) => (
              <button
                key={o.label}
                type="button"
                className={`btn agent-question-option${picked[i]!.includes(o.label) ? " is-picked" : ""}`}
                aria-pressed={picked[i]!.includes(o.label)}
                onClick={() => pick(i, o.label, !!q.multiple)}
              >
                <span>{o.label}</span>
                {o.description && <span className="muted">{o.description}</span>}
              </button>
            ))}
          </div>
          <input
            className="field-input"
            value={own[i]}
            placeholder={t("question.own")}
            aria-label={t("question.own")}
            onChange={(e) => setOwn((all) => all.map((v, j) => (j === i ? e.target.value : v)))}
          />
        </fieldset>
      ))}
      <div className="actions">
        <button className="btn is-primary" disabled={!ready || busy} onClick={() => void send()}>
          {t("question.send")}
        </button>
      </div>
    </div>
  );
}
