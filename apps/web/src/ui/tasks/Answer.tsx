import type { TaskView } from "@artel/shared";
import { useState } from "react";
import { useApp } from "../../context";
import { Markdown } from "../chat/Markdown";

/** The agent answered a question instead of changing the project: the answer and room for the next question. */
export function Answer({ task }: { task: TaskView }) {
  const { api, t } = useApp();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function ask() {
    setBusy(true);
    await api.tasks[":id"].feedback.$post({ param: { id: task.id }, json: { note: note.trim(), comments: [] } }).catch(() => null);
    setNote("");
    setBusy(false);
  }

  return (
    <section className="answer">
      <h2 className="sheet-h">{t("answer.title")}</h2>
      <div className="spec-doc">
        <Markdown text={task.summary ?? ""} />
      </div>
      <form
        className="answer-more"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim()) void ask();
        }}
      >
        <textarea className="field-input" rows={2} value={note} placeholder={t("answer.more")} aria-label={t("answer.more")} onChange={(e) => setNote(e.target.value)} />
        <button className="btn is-primary" disabled={busy || !note.trim()}>
          {t("answer.ask")}
        </button>
      </form>
    </section>
  );
}
