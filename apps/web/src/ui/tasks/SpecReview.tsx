import type { TaskView } from "@artel/shared";
import { useState } from "react";
import { useApp } from "../../context";
import { Markdown } from "../chat/Markdown";

/** The agent's spec on a sheet: read it, edit text and check commands, start or send back. */
export function SpecReview({ task }: { task: TaskView }) {
  const { api, t } = useApp();
  const [spec, setSpec] = useState(task.spec ?? "");
  const [checks, setChecks] = useState<string[]>(task.checks);
  const [editing, setEditing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    const cleaned = checks.map((c) => c.trim()).filter(Boolean);
    await api.tasks[":id"].spec.$post({ param: { id: task.id }, json: { spec: spec.trim(), checks: cleaned } }).catch(() => null);
    setBusy(false);
  }

  async function revise() {
    setBusy(true);
    await api.tasks[":id"].spec.revise.$post({ param: { id: task.id }, json: { note: note.trim() } }).catch(() => null);
    setBusy(false);
  }

  return (
    <section className="spec-review">
      <div className="spec-head">
        <h2 className="sheet-h">{t("spec.title")}</h2>
        <button className="link" onClick={() => setEditing(!editing)}>
          {editing ? t("spec.preview") : t("spec.edit")}
        </button>
      </div>
      <p className="muted">{t("spec.lede")}</p>

      {editing ? (
        <textarea className="field-input spec-editor mono" rows={16} value={spec} aria-label={t("spec.title")} onChange={(e) => setSpec(e.target.value)} />
      ) : (
        <div className="spec-doc">
          <Markdown text={spec} />
        </div>
      )}

      {task.plan.length > 0 && (
        <>
          <h3 className="spec-sub">{t("spec.plan")}</h3>
          <ol className="steps">
            {task.plan.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </>
      )}

      <h3 className="spec-sub">{t("spec.checks")}</h3>
      <p className="muted spec-hint">{t("spec.checksHint")}</p>
      <ul className="check-list">
        {checks.map((c, i) => (
          <li key={i}>
            <input
              className="field-input mono"
              value={c}
              aria-label={t("spec.checkLabel", { n: i + 1 })}
              onChange={(e) => setChecks(checks.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button className="link is-pencil" onClick={() => setChecks(checks.filter((_, j) => j !== i))}>
              {t("spec.removeCheck")}
            </button>
          </li>
        ))}
      </ul>
      {checks.length === 0 && <p className="error-note">{t("spec.noChecks")}</p>}
      <button className="link" onClick={() => setChecks([...checks, ""])}>
        {t("spec.addCheck")}
      </button>

      {revising && (
        <label className="field spec-revise">
          <span>{t("spec.revisePlaceholder")}</span>
          <textarea className="field-input" rows={3} value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
        </label>
      )}

      <div className="actions spec-actions">
        <button className="btn is-primary" disabled={busy || !spec.trim()} onClick={() => void start()}>
          {t("spec.start")}
        </button>
        {revising ? (
          <button className="btn is-pencil" disabled={busy || !note.trim()} onClick={() => void revise()}>
            {t("spec.reviseSend")}
          </button>
        ) : (
          <button className="btn" onClick={() => setRevising(true)}>
            {t("spec.revise")}
          </button>
        )}
      </div>
    </section>
  );
}
