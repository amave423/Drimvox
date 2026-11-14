import { CHAIN_PROVIDER_ID, type ModelRef, type ProjectWorkView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { useBoxPrefs } from "../../lib/boxPrefs";
import { readLastModel, rememberLastModel, type ModelChoice } from "../../lib/lastModel";
import { MAX_BYTES, MAX_FILES, prepareFile, toBase64, type PendingFile } from "../chat/Attachments";
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
  // Screenshots and files for the next message, as in a chat (asked for: a project could not be shown a screenshot).
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
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

  async function addFiles(added: File[]) {
    setAttachError(null);
    const prepared = await Promise.all(added.map(prepareFile));
    if (prepared.some((f) => f === null)) setAttachError("format");
    const ready = prepared.filter((f): f is File => f !== null);
    const next = [...files, ...ready.map((file) => ({ key: `${file.name}-${file.size}-${Math.random()}`, file }))];
    if (next.length > MAX_FILES) return setAttachError("too_many");
    if (next.reduce((sum, f) => sum + f.file.size, 0) > MAX_BYTES) return setAttachError("too_big");
    setFiles(next);
  }

  async function send(content: string) {
    setFailed(null);
    setAttachError(null);
    const attached = await Promise.all(files.map(async (f) => ({ name: f.file.name, type: f.file.type, data: await toBase64(f.file) })));
    // While it works the message goes into the run on the way, as in a chat; it answers the agent's question, if one waits.
    if (running) {
      const res = await api.projects[":id"].work.message.$post({ param: { id: projectId }, json: { content, thinking: prefs.thinking, files: attached } }).catch(() => null);
      if (!res?.ok) setFailed("unknown");
      else setFiles([]);
      return sent();
    }
    if (!choice) return;
    rememberLastModel(choice);
    const res = await api.projects[":id"].work.chat
      .$post({
        param: { id: projectId },
        json: { content, model: ref(choice), thinking: prefs.thinking, strong: null, files: attached },
      })
      .catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { code?: string } } | null;
      setFailed(body?.error?.code ?? "unknown");
    } else setFiles([]);
    sent();
  }

  return (
    <>
      {failed && <p className="error-note">{t(failed === "unknown" ? "chat.sendFailed" : failed === "too_big" ? "attach.too_big" : (`projectWork.error.${failed}` as MessageKey))}</p>}
      {attachError && <p className="error-note">{t(`attach.${attachError}` as MessageKey, { max: MAX_FILES })}</p>}
      <Composer
        disabled={!running && !choice}
        streaming={false}
        onSend={(text) => void send(text)}
        onStop={() => {}}
        picker={<ModelPicker value={choice} onChange={setChoice} placement="above" />}
        attach={{ files, onAdd: (added) => void addFiles(added), onRemove: (key) => setFiles(files.filter((f) => f.key !== key)) }}
        draftKey={`project:${projectId}`}
        // The strong model and the thinking are in the project's parameters on the right (asked for: they were a pop-up here).
        options={{ changed: [], rows: [] }}
        placeholder={t(running ? "chat.workPlaceholder" : "chat.readyPlaceholder")}
      />
    </>
  );
}
