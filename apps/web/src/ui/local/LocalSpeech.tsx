import type { LocalSpeechStatus, LocalVoiceId } from "@drimvox/shared";
import { useCallback, useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { downloadsChanged } from "../DownloadNote";
import { EngineRow } from "./EngineRow";
import { PullControl, type PullActions } from "./PullControl";

/**
 * Reading answers aloud on this computer (docs/specs/local-speech.md, asked for: the system's voice sounded like a
 * robot): Piper's voices, downloaded with the engine; one of them becomes the voice that reads answers.
 */
export function LocalSpeechSection() {
  const { api, t, settings, updateSettings } = useApp();
  const [status, setStatus] = useState<LocalSpeechStatus | null>(null);
  const load = useCallback(async () => {
    const next = await api.local.speech
      .$get()
      .then((r) => ok<LocalSpeechStatus>(r))
      .catch(() => null);
    if (next) setStatus(next);
  }, [api]);
  useEffect(() => void load(), [load]);
  const downloading = !!status?.voices.some((v) => v.pull && !v.pull.done && !v.pull.paused);
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [downloading, load]);

  const act = (run: (voice: LocalVoiceId) => Promise<unknown>) => (voice: string) =>
    void run(voice as LocalVoiceId)
      .catch(() => null)
      .then(() => (downloadsChanged(), load()));
  const actions: PullActions = {
    pull: act((voice) => api.local.speech.pulls.$post({ json: { voice } })),
    pause: act((voice) => api.local.speech.pulls.pause.$post({ json: { voice } })),
    cancel: act((voice) => api.local.speech.pulls.$delete({ query: { voice } })),
    remove: act(async (voice) => {
      await api.local.speech.voices.$delete({ query: { voice } });
      if (settings.speechVoice === voice) await updateSettings({ speechVoice: null });
    }),
  };

  if (!status) return null;
  // The interface's language first: those are the voices that will read.
  const voices = [...status.voices].sort((a, b) => Number(b.lang === settings.locale) - Number(a.lang === settings.locale));
  return (
    <>
      <h2 className="sheet-h">{t("localSpeech.title")}</h2>
      <p className="muted">{t("localSpeech.hint")}</p>
      {!status.supported && <p className="note">{t("localSpeech.unsupported")}</p>}
      {status.supported && status.engine && (
        <EngineRow
          name="Piper"
          onRemove={async () => {
            const res = await api.local.speech.engine.$delete().catch(() => null);
            await load();
            return !!res?.ok;
          }}
        />
      )}
      {status.supported && (
        <ul className="local-cards local-audio-cards">
          {voices.map((v) => {
            const chosen = settings.speechVoice === v.id;
            return (
              <li key={v.id} className="local-card">
                <div className="local-card-head">
                  <span className="local-card-name">{v.name}</span>
                  <span className="local-fit is-quiet">{t(`localSpeech.${v.lang === "ru" ? "ru" : "en"}.${v.gender}`)}</span>
                </div>
                <PullControl model={v.id} sizeBytes={v.sizeBytes} installed={v.installed} pull={v.pull ?? undefined} actions={actions} />
                {v.installed && (
                  <p>
                    {chosen ? (
                      <span className="is-ok-text">{t("localSpeech.chosen")}</span>
                    ) : (
                      <button className="link" onClick={() => void updateSettings({ speechVoice: v.id })}>
                        {t("localSpeech.choose")}
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
