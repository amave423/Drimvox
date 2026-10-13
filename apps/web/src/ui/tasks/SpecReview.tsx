import type { TaskView } from "@artel/shared";
import { useState } from "react";
import { useApp } from "../../context";
import { Markdown } from "../chat/Markdown";
import { RequirementsList } from "./AcceptanceReport";
import { ChecksEditor } from "./ChecksEditor";

/** The agent's spec on a sheet: read it, edit text and check commands, start or send back. */
export function SpecReview({ task }: { task: TaskView }) {
  const { api, t } = useApp();
  const [spec, setSpec] = useState(task.spec ?? "");
  const [checks, setChecks] = useState<string[]>(task.checks);
  const [visual, setVisual] = useState(task.visualChecks);
  const [editing, setEditing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    const cleaned = checks.map((c) => c.trim()).filter(Boolean);
    await api.tasks[":id"].spec.$post({ param: { id: task.id }, json: { spec: spec.trim(), checks: cleaned, visualChecks: visual } }).catch(() => null);
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

      <RequirementsList requirements={task.requirements} decisions={task.decisions} />

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

      <ChecksEditor checks={checks} onChange={setChecks} />
      {visual.length > 0 && (
        <>
          <h3 className="spec-sub">{t("spec.visual")}</h3>
          <p className="muted spec-hint">{t("spec.visualHint")}</p>
          <ul className="visual-list">
            {visual.map((v, i) => (
              <li key={i}>
                <span className="mono">{v.url}</span>
                <span>{v.expect}</span>
                {v.start && <span className="mono muted">{t("spec.visualStart", { command: v.start })}</span>}
                <button className="link is-pencil" onClick={() => setVisual(visual.filter((_, j) => j !== i))}>
                  {t("spec.removeCheck")}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

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
