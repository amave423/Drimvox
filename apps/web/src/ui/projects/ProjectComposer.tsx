import { CHAIN_PROVIDER_ID, type ModelRef, type ProjectWorkView, type ThinkingLevel } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { readLastModel, rememberLastModel, type ModelChoice } from "../../lib/lastModel";
import { Composer } from "../chat/Composer";
import { ModelPicker } from "../chat/ModelPicker";
import { ThinkingSwitch } from "../chat/ThinkingSwitch";
import { Toggle } from "../Toggle";

/** What the box of a project keeps between messages and visits, per project. */
interface BoxPrefs {
  interview: boolean;
  plan: boolean;
  /** The interview's model and the plan's (asked for: each its own); null: the working one. */
  interviewModel: ModelChoice | null;
  planModel: ModelChoice | null;
  strong: ModelChoice | null;
  thinking: ThinkingLevel;
}

const prefsKey = (projectId: string) => `drimvox.projectBox.${projectId}`;
const DEFAULTS: BoxPrefs = { interview: false, plan: false, interviewModel: null, planModel: null, strong: null, thinking: "auto" };

function readPrefs(projectId: string): BoxPrefs {
  try {
    const kept = localStorage.getItem(prefsKey(projectId));
    return kept ? { ...DEFAULTS, ...(JSON.parse(kept) as Partial<BoxPrefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const ref = (c: ModelChoice): ModelRef => ({ providerId: c.providerId, model: c.model });

/**
 * A project's message box (asked for: one conversation per project, as a ready project had; variant A of the designs):
 * the model, and under "Options" whether an interview and a plan to approve come first, their model, the strong model
 * that steps in when the working one is stuck, and how much the model thinks. Off, both: the agent starts at once.
 */
export function ProjectComposer({ projectId, work, onSent }: { projectId: string; work: ProjectWorkView | null; onSent(): void }) {
  const { api, t, providers } = useApp();
  const [prefs, setPrefs] = useState<BoxPrefs>(() => readPrefs(projectId));
  const [choice, setChoice] = useState<ModelChoice | null>(() => {
    const own = work?.models?.work;
    if (own) return { providerId: own.providerId, model: own.model };
    const last = readLastModel();
    return last && (last.providerId === CHAIN_PROVIDER_ID || providers.some((p) => p.id === last.providerId)) ? last : null;
  });
  const [failed, setFailed] = useState<string | null>(null);
  // The work's own model, once the work has loaded (seen: the box opened before it and said "Pick a model" after a run).
  const workModel = work?.models?.work;
  useEffect(() => {
    if (workModel) setChoice((c) => c ?? { providerId: workModel.providerId, model: workModel.model });
  }, [workModel?.providerId, workModel?.model]);
  useEffect(() => {
    try {
      localStorage.setItem(prefsKey(projectId), JSON.stringify(prefs));
    } catch {
      // Kept for this visit only.
    }
  }, [projectId, prefs]);
  const set = (patch: Partial<BoxPrefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const running = work?.status === "running";
  // The plan waits for "Start work": what is written now corrects it. While the questions or the plan are being made,
  // the box waits (the questions are answered in their card).
  const planReady = work?.status === "ready" && !!work.plan;
  const preparing = work?.status === "planning";

  async function send(content: string) {
    setFailed(null);
    if (planReady) {
      const res = await api.projects[":id"].work.revise.$post({ param: { id: projectId }, json: { note: content } }).catch(() => null);
      if (!res?.ok) setFailed("unknown");
      return onSent();
    }
    // While it works the message goes into the run on the way, as in a chat.
    if (running) {
      const res = await api.projects[":id"].work.message.$post({ param: { id: projectId }, json: { content, thinking: prefs.thinking } }).catch(() => null);
      if (!res?.ok) setFailed("unknown");
      return onSent();
    }
    if (!choice) return;
    rememberLastModel(choice);
    const res =
      prefs.interview || prefs.plan
        ? // First the questions and/or the plan to approve; the work starts with "Go" on the plan, in this conversation.
          await api.projects[":id"].work.plan
            .$post({
              param: { id: projectId },
              json: {
                task: content,
                models: {
                  interview: ref(prefs.interviewModel ?? choice),
                  plan: ref(prefs.planModel ?? choice),
                  work: ref(choice),
                  strong: prefs.strong ? ref(prefs.strong) : null,
                },
                quick: !prefs.interview,
              },
            })
            .catch(() => null)
        : await api.projects[":id"].work.chat
            .$post({
              param: { id: projectId },
              json: { content, model: ref(choice), thinking: prefs.thinking, strong: prefs.strong ? ref(prefs.strong) : null },
            })
            .catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { code?: string } } | null;
      setFailed(body?.error?.code ?? "unknown");
    }
    onSent();
  }

  /** A stage's own model: the working one until another is picked, with the way back. */
  const stageModel = (key: "interviewModel" | "planModel") => (
    <span className="options-model">
      <ModelPicker value={prefs[key] ?? choice} onChange={(m) => set({ [key]: m })} placement="above" />
      {prefs[key] && (
        <button type="button" className="link" onClick={() => set({ [key]: null })}>
          {t("projectBox.asWorking")}
        </button>
      )}
    </span>
  );

  const changed = [
    ...(prefs.interview ? [t("projectBox.interview")] : []),
    ...(prefs.plan ? [t("projectBox.plan")] : []),
    ...(prefs.thinking !== "auto" ? [t("thinking.short", { level: t(`thinking.${prefs.thinking}` as MessageKey) })] : []),
    ...(prefs.strong ? [t("projectBox.strongShort")] : []),
  ];

  return (
    <>
      {failed && <p className="error-note">{t(failed === "unknown" ? "chat.sendFailed" : (`projectWork.error.${failed}` as MessageKey))}</p>}
      <Composer
        disabled={preparing || (!running && !planReady && !choice)}
        streaming={false}
        onSend={(text) => void send(text)}
        onStop={() => {}}
        picker={<ModelPicker value={choice} onChange={setChoice} placement="above" />}
        options={{
          changed,
          wide: true,
          rows: [
            {
              label: t("projectBox.interview"),
              control: (
                <Toggle checked={prefs.interview} onChange={(interview) => set({ interview })}>
                  <span className="options-about">{t("projectBox.interviewHint")}</span>
                </Toggle>
              ),
            },
            {
              label: t("projectBox.plan"),
              control: (
                <Toggle checked={prefs.plan} onChange={(plan) => set({ plan })}>
                  <span className="options-about">{t("projectBox.planHint")}</span>
                </Toggle>
              ),
            },
            ...(prefs.interview ? [{ label: t("projectBox.interviewModel"), control: stageModel("interviewModel") }] : []),
            ...(prefs.plan ? [{ label: t("projectBox.planModel"), control: stageModel("planModel") }] : []),
            {
              label: t("projectBox.strong"),
              control: (
                <span className="options-model">
                  {prefs.strong ? (
                    <>
                      <ModelPicker value={prefs.strong} onChange={(strong) => set({ strong })} placement="above" />
                      <button type="button" className="link" onClick={() => set({ strong: null })}>
                        {t("projectWork.strongRemove")}
                      </button>
                    </>
                  ) : (
                    <ModelPicker value={null} onChange={(strong) => set({ strong })} placement="above" />
                  )}
                </span>
              ),
            },
            { label: t("thinking.label"), control: <ThinkingSwitch value={prefs.thinking} onChange={(thinking) => set({ thinking })} /> },
          ],
        }}
        placeholder={t(running ? "chat.workPlaceholder" : planReady ? "planning.fixPlaceholder" : preparing ? "planning.waitPlaceholder" : "chat.readyPlaceholder")}
      />
    </>
  );
}
