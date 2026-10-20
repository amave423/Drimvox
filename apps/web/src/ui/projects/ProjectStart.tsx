import type { ModelRef, TaskView } from "@artel/shared";
import { useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { rememberLastModel, type ModelChoice } from "../../lib/lastModel";
import { ModelPicker } from "../chat/ModelPicker";

const ROLES = ["interview", "plan", "work"] as const;
type Role = (typeof ROLES)[number];

const ref = (c: ModelChoice): ModelRef => ({ providerId: c.providerId, model: c.model });

/**
 * The start of a project's work (docs/specs/project-work.md): what to make, and who does what — the interview, the plan,
 * the work, and the strong model that steps in when the working one is stuck.
 */
export function ProjectStart({ projectId, initial, onStarted }: { projectId: string; initial: ModelChoice | null; onStarted(task: TaskView): void }) {
  const { api, t } = useApp();
  const [text, setText] = useState("");
  const [models, setModels] = useState<Record<Role, ModelChoice | null>>({ interview: initial, plan: initial, work: initial });
  const [strong, setStrong] = useState<ModelChoice | null>(null);
  const [addingStrong, setAddingStrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const ready = ROLES.every((r) => models[r]) && !!text.trim();

  async function start() {
    if (!ready) return;
    setBusy(true);
    setFailed(null);
    const res = await api.projects[":id"].work.plan
      .$post({
        param: { id: projectId },
        json: { task: text.trim(), models: { interview: ref(models.interview!), plan: ref(models.plan!), work: ref(models.work!), strong: strong ? ref(strong) : null } },
      })
      .catch(() => null);
    setBusy(false);
    const body = (await res?.json().catch(() => null)) as (TaskView & { error?: { code?: string } }) | null;
    if (!res?.ok || !body) return setFailed(body?.error?.code ?? "unknown");
    rememberLastModel(models.work!);
    onStarted(body);
  }

  // One choice fills the roles still on the default, so a single model needs a single pick.
  function choose(role: Role, choice: ModelChoice) {
    setModels((m) => (role === "interview" && m.plan === m.interview && m.work === m.interview ? { interview: choice, plan: choice, work: choice } : { ...m, [role]: choice }));
  }

  return (
    <section className="project-start">
      <h2 className="sheet-h">{t("projectWork.startTitle")}</h2>
      <p className="muted">{t("projectWork.startLede")}</p>
      <form
        className="task-form"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <textarea
          className="field-input task-input"
          rows={5}
          value={text}
          placeholder={t("projectWork.placeholder")}
          aria-label={t("projectWork.startTitle")}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="project-models" role="group" aria-label={t("projectWork.models")}>
          {ROLES.map((role) => (
            <div key={role} className="project-model">
              <span className="field-label">{t(`projectWork.model.${role}` as MessageKey)}</span>
              <ModelPicker value={models[role]} onChange={(c) => choose(role, c)} />
            </div>
          ))}
          <div className="project-model">
            <span className="field-label" title={t("projectWork.strongHint")}>
              {t("projectWork.model.strong")}
            </span>
            {strong || addingStrong ? (
              <span className="project-model-row">
                <ModelPicker value={strong} onChange={setStrong} />
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setStrong(null);
                    setAddingStrong(false);
                  }}
                >
                  {t("projectWork.strongRemove")}
                </button>
              </span>
            ) : (
              <button type="button" className="link" onClick={() => setAddingStrong(true)}>
                {t("projectWork.strongAdd")}
              </button>
            )}
          </div>
        </div>
        <p className="muted project-strong-hint">{t("projectWork.strongHint")}</p>
        <div className="actions">
          <button className="btn is-primary" disabled={busy || !ready}>
            {t("projectWork.start")}
          </button>
        </div>
        {failed && <p className="error-note">{t(`projectWork.error.${failed}` as MessageKey)}</p>}
      </form>
    </section>
  );
}
