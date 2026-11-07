import { CHAIN_PROVIDER_ID, type ModelRef, type ProjectWorkView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { useBoxPrefs } from "../../lib/boxPrefs";
import { readLastModel, rememberLastModel, type ModelChoice } from "../../lib/lastModel";
import { Composer } from "../chat/Composer";
import { ModelPicker } from "../chat/ModelPicker";

const ref = (c: ModelChoice): ModelRef => ({ providerId: c.providerId, model: c.model });

/**
 * A project's message box (asked for: one conversation per project, as a ready project had; variant A of the designs):
 * the model, and what is written. Whether an interview and a plan come first, their models, the strong model and the
 * thinking are set in the project's parameters (useBoxPrefs); off, both: the agent starts at once.
 */
export function ProjectComposer({ projectId, work, onSent }: { projectId: string; work: ProjectWorkView | null; onSent(): void }) {
  const { api, t, providers, reloadWorks } = useApp();
  const [prefs] = useBoxPrefs(projectId);
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
  const running = work?.status === "running";
  // The plan waits for "Start work": what is written now corrects it. While the questions or the plan are being made,
  // the box waits (the questions are answered in their card).
  const planReady = work?.status === "ready" && !!work.plan;
  // A plan that stopped on an error does not lock the box: a message goes on with it (seen: nothing could be written).
  const preparing = work?.status === "planning" && !work.planStalled;

  /** The app's list of works too: the top bar says "working" at once (seen: only after leaving and coming back). */
  const sent = () => {
    reloadWorks();
    onSent();
  };

  async function send(content: string) {
    setFailed(null);
    if (planReady || work?.planStalled) {
      const res = await api.projects[":id"].work.revise.$post({ param: { id: projectId }, json: { note: content } }).catch(() => null);
      if (!res?.ok) setFailed("unknown");
      return sent();
    }
    // While it works the message goes into the run on the way, as in a chat.
    if (running) {
      const res = await api.projects[":id"].work.message.$post({ param: { id: projectId }, json: { content, thinking: prefs.thinking } }).catch(() => null);
      if (!res?.ok) setFailed("unknown");
      return sent();
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
    sent();
  }

  return (
    <>
      {failed && <p className="error-note">{t(failed === "unknown" ? "chat.sendFailed" : (`projectWork.error.${failed}` as MessageKey))}</p>}
      <Composer
        disabled={preparing || (!running && !planReady && !choice)}
        streaming={false}
        onSend={(text) => void send(text)}
        onStop={() => {}}
        picker={<ModelPicker value={choice} onChange={setChoice} placement="above" />}
        // The interview, the plan, their models and the thinking are in the project's parameters on the right (asked
        // for: they were a pop-up here).
        options={{ changed: [], rows: [] }}
        placeholder={t(running ? "chat.workPlaceholder" : planReady ? "planning.fixPlaceholder" : preparing ? "planning.waitPlaceholder" : "chat.readyPlaceholder")}
      />
    </>
  );
}
