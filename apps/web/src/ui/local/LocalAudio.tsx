import type { LocalAudioModelId, LocalAudioStatus } from "@drimvox/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { downloadsChanged } from "../DownloadNote";
import { PullControl, type PullActions } from "./PullControl";

/**
 * Speech on this computer (docs/specs/local-audio.md, asked for: an engine for local audio models and an Audio tab):
 * whisper.cpp's models, downloaded with the engine; once one is here, it can be the voice model for dictation.
 */
export function LocalAudioSection() {
  const { api, t, reloadProviders, settings, updateSettings } = useApp();
  const [status, setStatus] = useState<LocalAudioStatus | null>(null);
  const known = useRef<string | null>(null);

  const load = useCallback(async () => {
    const next = await api.local.audio
      .$get()
      .then((r) => ok<LocalAudioStatus>(r))
      .catch(() => null);
    if (!next) return;
    setStatus(next);
    const key = `${next.providerId}:${next.models.filter((m) => m.installed).map((m) => m.id).join()}`;
    if (known.current !== null && known.current !== key) void reloadProviders();
    known.current = key;
  }, [api, reloadProviders]);
  useEffect(() => void load(), [load]);
  const downloading = !!status?.models.some((m) => m.pull && !m.pull.done && !m.pull.paused);
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [downloading, load]);

  const act = (run: (model: LocalAudioModelId) => Promise<unknown>) => (model: string) =>
    void run(model as LocalAudioModelId)
      .catch(() => null)
      .then(() => (downloadsChanged(), load()));
  const actions: PullActions = {
    pull: act((model) => api.local.audio.pulls.$post({ json: { model } })),
    pause: act((model) => api.local.audio.pulls.pause.$post({ json: { model } })),
    cancel: act((model) => api.local.audio.pulls.$delete({ query: { model } })),
    remove: act((model) => api.local.audio.models[":id"].$delete({ param: { id: model } })),
  };

  if (!status) return null;
  return (
    <>
      <h2 className="sheet-h">{t("localAudio.title")}</h2>
      <p className="muted">{t("localAudio.hint")}</p>
      {!status.supported && <p className="note">{t("localAudio.unsupported")}</p>}
      {status.supported && (
        <ul className="local-cards local-audio-cards">
          {status.models.map((m) => {
            const chosen = settings.voiceModel?.providerId === status.providerId && settings.voiceModel?.model === m.id;
            return (
              <li key={m.id} className="local-card">
                <div className="local-card-head">
                  <span className="local-card-name">{m.name}</span>
                  {/* Speed and accuracy are not good or bad: only the recommended one is green (seen: three greens said nothing). */}
                  <span className={m.note === "balanced" ? "local-fit is-fast" : "local-fit is-quiet"}>{t(`localAudio.note.${m.note}` as MessageKey)}</span>
                </div>
                <p>{t(`localAudio.model.${m.id}` as MessageKey)}</p>
                <PullControl model={m.id} sizeBytes={m.sizeBytes} installed={m.installed} pull={m.pull ?? undefined} actions={actions} />
                {m.installed && status.providerId && (
                  <p>
                    {chosen ? (
                      <span className="is-ok-text">{t("localAudio.chosen")}</span>
                    ) : (
                      <button className="link" onClick={() => void updateSettings({ voiceModel: { providerId: status.providerId!, model: m.id } })}>
                        {t("localAudio.choose")}
                      </button>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
