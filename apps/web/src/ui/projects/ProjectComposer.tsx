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
 * the model, and what is written. The strong model and the thinking are set in the project's parameters (useBoxPrefs).
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

  /** The app's list of works too: the top bar says "working" at once (seen: only after leaving and coming back). */
  const sent = () => {
    reloadWorks();
    onSent();
  };

  async function send(content: string) {
    setFailed(null);
    // While it works the message goes into the run on the way, as in a chat; it answers the agent's question, if one waits.
    if (running) {
      const res = await api.projects[":id"].work.message.$post({ param: { id: projectId }, json: { content, thinking: prefs.thinking } }).catch(() => null);
      if (!res?.ok) setFailed("unknown");
      return sent();
    }
    if (!choice) return;
    rememberLastModel(choice);
    const res = await api.projects[":id"].work.chat
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
        disabled={!running && !choice}
        streaming={false}
        onSend={(text) => void send(text)}
        onStop={() => {}}
        picker={<ModelPicker value={choice} onChange={setChoice} placement="above" />}
        // The strong model and the thinking are in the project's parameters on the right (asked for: they were a pop-up here).
        options={{ changed: [], rows: [] }}
        placeholder={t(running ? "chat.workPlaceholder" : "chat.readyPlaceholder")}
      />
    </>
  );
}
