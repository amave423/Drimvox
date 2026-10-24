import type { PlannedSubtask, TaskView } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";
import { Markdown } from "../chat/Markdown";
import { RequirementsList } from "./AcceptanceReport";
import { DesignBriefView } from "./Design";
import { ChecksEditor } from "./ChecksEditor";

/** The lead agent's plan for a team: the spec, the subtasks and the checks. Edit, start or send back. */
export function PlanReview({ task }: { task: TaskView }) {
  const { api, t } = useApp();
  const [spec, setSpec] = useState(task.spec ?? "");
  const [checks, setChecks] = useState<string[]>(task.checks);
  const [subtasks, setSubtasks] = useState<PlannedSubtask[]>(task.plannedSubtasks);
  const [editing, setEditing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const titles = new Map(subtasks.map((s) => [s.id, s.title]));
  const patch = (i: number, p: Partial<PlannedSubtask>) => setSubtasks(subtasks.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const complete = subtasks.length > 0 && subtasks.every((s) => s.title.trim() && s.description.trim());

  async function start() {
    setBusy(true);
    const json = {
      spec: spec.trim(),
      checks: checks.map((c) => c.trim()).filter(Boolean),
      subtasks: subtasks.map((s) => ({
        ...s,
        dependsOn: s.dependsOn.filter((d) => titles.has(d)),
        checks: s.checks.map((c) => c.trim()).filter(Boolean),
      })),
    };
    await api.tasks[":id"].plan.$post({ param: { id: task.id }, json }).catch(() => null);
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
        <h2 className="sheet-h">{t("plan.title")}</h2>
        <button className="link" onClick={() => setEditing(!editing)}>
          {editing ? t("spec.preview") : t("spec.edit")}
        </button>
      </div>
      <p className="muted">{t("plan.lede")}</p>

      {editing ? (
        <textarea className="field-input spec-editor mono" rows={12} value={spec} aria-label={t("plan.spec")} onChange={(e) => setSpec(e.target.value)} />
      ) : (
        <div className="spec-doc">
          <Markdown text={spec} />
        </div>
      )}

      <RequirementsList requirements={task.requirements} decisions={task.decisions} milestones={task.milestones} />
      {task.design && <DesignBriefView brief={task.design} />}

      <h3 className="spec-sub">{t("plan.subtasks", { count: subtasks.length })}</h3>
      <p className="muted spec-hint">{t("plan.subtasksHint")}</p>
      <ol className="plan-cards">
        {subtasks.map((s, i) => {
          const after = s.dependsOn.filter((d) => titles.has(d)).map((d) => titles.get(d));
          return (
            <li key={s.id} className="plan-card">
              {editing ? (
                <>
                  <input className="field-input" value={s.title} aria-label={t("plan.subtaskTitle", { n: i + 1 })} onChange={(e) => patch(i, { title: e.target.value })} />
                  <textarea
                    className="field-input"
                    rows={3}
                    value={s.description}
                    aria-label={t("plan.subtaskDescription", { n: i + 1 })}
                    onChange={(e) => patch(i, { description: e.target.value })}
                  />
                  <textarea
                    className="field-input mono"
                    rows={Math.max(1, s.checks.length)}
                    value={s.checks.join("\n")}
                    placeholder={t("plan.subtaskChecksEmpty")}
                    aria-label={t("plan.subtaskChecks", { n: i + 1 })}
                    onChange={(e) => patch(i, { checks: e.target.value.split("\n") })}
                  />
                </>
              ) : (
                <>
                  <strong>{s.title}</strong>
                  <p>{s.description}</p>
                  <p className="plan-card-checks mono muted">
                    {s.checks.length ? s.checks.join("\n") : t("plan.subtaskChecksEmpty")}
                  </p>
                </>
              )}
              <div className="plan-card-foot">
                <span className="muted">{after.length ? t("plan.after", { list: after.join(", ") }) : t("plan.atOnce")}</span>
                {subtasks.length > 1 && (
                  <button className="link is-pencil" onClick={() => setSubtasks(subtasks.filter((_, j) => j !== i))}>
                    {t("plan.removeSubtask")}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <ChecksEditor checks={checks} onChange={setChecks} />

      {revising && (
        <label className="field spec-revise">
          <span>{t("plan.revisePlaceholder")}</span>
          <textarea className="field-input" rows={3} value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
        </label>
      )}

      <div className="actions spec-actions">
        <button className="btn is-primary" disabled={busy || !spec.trim() || !complete} onClick={() => void start()}>
          {t("plan.start")}
        </button>
        {revising ? (
          <button className="btn is-pencil" disabled={busy || !note.trim()} onClick={() => void revise()}>
            {t("spec.reviseSend")}
          </button>
        ) : (
          <button className="btn" onClick={() => setRevising(true)}>
            {t("plan.revise")}
          </button>
        )}
      </div>
    </section>
  );
}
