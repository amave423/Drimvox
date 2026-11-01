import type { CloudSpeechModel, LocalSpeechStatus, LocalVoiceId } from "@drimvox/shared";
import { useEffect, useRef, useState } from "react";
import { authHeaders, ok } from "../api";
import { useApp } from "../context";
import { Segmented } from "./Segmented";
import { Setting } from "./Setting";
import { Dropdown } from "./Dropdown";

const SYSTEM = "system";

/** Which voice reads answers aloud: the system's, or one of the Piper voices downloaded (docs/specs/local-speech.md). */
export function SpeechVoiceSetting() {
  const { api, t, settings, updateSettings, navigate } = useApp();
  const [status, setStatus] = useState<LocalSpeechStatus | null>(null);
  useEffect(() => {
    void api.local.speech
      .$get()
      .then((r) => ok<LocalSpeechStatus>(r))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [api]);
  const installed = status?.voices.filter((v) => v.installed) ?? [];
  return (
    <Setting id="speech-voice-label" title={t("settings.speechVoice")} about={t("settings.speechVoiceHint")}>
      {/* The voices here are chosen in place; more are downloaded on the audio tab (seen: a lone link under the setting
          looked out of place). */}
      {installed.length > 0 ? (
        <div className="speech-voice">
          <Segmented<string>
            labelledBy="speech-voice-label"
            value={settings.speechVoice ?? SYSTEM}
            options={[{ value: SYSTEM, label: t("settings.speechVoiceSystem") }, ...installed.map((v) => ({ value: v.id, label: v.name }))]}
            onChange={(value) => void updateSettings({ speechVoice: value === SYSTEM ? null : (value as LocalVoiceId) })}
          />
          <button type="button" className="link" onClick={() => navigate({ kind: "local", part: "audio" })}>
            {t("settings.speechVoiceMore")}
          </button>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => navigate({ kind: "local", part: "audio" })}>
          {t("settings.speechVoiceGet")}
        </button>
      )}
    </Setting>
  );
}

const NONE = "none";

/**
 * A provider's voice that reads answers instead of the Piper or system one (asked for: voices from every provider that
 * has them): the speech models of the connected providers, then a voice of the chosen one, and a sample to hear it.
 */
export function CloudVoiceSetting() {
  const { t, settings, updateSettings, token } = useApp();
  const [models, setModels] = useState<CloudSpeechModel[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  useEffect(() => {
    void fetch("/api/voice/cloud", { headers: authHeaders(token) })
      .then((r) => (r.ok ? (r.json() as Promise<CloudSpeechModel[]>) : []))
      .then(setModels)
      .catch(() => setModels([]));
  }, [token]);
  const chosen = settings.cloudVoice;
  const key = (m: { providerId: string; model: string }) => `${m.providerId}|${m.model}`;
  const model = chosen ? models?.find((m) => key(m) === key(chosen)) : undefined;

  async function sample() {
    if (state === "playing") {
      audio.current?.pause();
      setState("idle");
      return;
    }
    setProblem(null);
    setState("loading");
    try {
      const res = await fetch("/api/voice/speak", { method: "POST", headers: { ...authHeaders(token), "content-type": "application/json" }, body: JSON.stringify({ text: t("settings.cloudVoiceSample") }) });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { detail?: string } } | null;
        throw new Error(body?.error?.detail ?? String(res.status));
      }
      const url = URL.createObjectURL(await res.blob());
      const player = new Audio(url);
      audio.current = player;
      player.onended = () => {
        URL.revokeObjectURL(url);
        setState("idle");
      };
      await player.play();
      setState("playing");
    } catch (err) {
      setProblem(`${t("settings.cloudVoiceFailed")} ${err instanceof Error ? err.message : ""}`.trim());
      setState("idle");
    }
  }

  return (
    <Setting id="cloud-voice-label" title={t("settings.cloudVoice")} about={t("settings.cloudVoiceHint")}>
      {models === null ? (
        <p className="muted">{t("settings.cloudVoiceLooking")}</p>
      ) : models.length === 0 ? (
        <p className="muted">{t("settings.cloudVoiceNone")}</p>
      ) : (
        <div className="cloud-voice">
          <Dropdown<string>
            label={t("settings.cloudVoiceModel")}
            search={t("settings.cloudVoiceSearch")}
            value={chosen ? key(chosen) : NONE}
            options={[
              { value: NONE, label: t("settings.cloudVoiceOff") },
              ...models.map((m) => ({ value: key(m), label: m.name, hint: `${m.provider}${m.free ? ` · ${t("settings.cloudVoiceFree")}` : ""} · ${t("settings.cloudVoiceCount", { n: m.voices.length })}` })),
            ]}
            onChange={(value) => {
              setProblem(null);
              const next = models.find((m) => key(m) === value);
              // A new model starts on its first voice; the same voice is kept when the new model has it.
              void updateSettings({ cloudVoice: next ? { providerId: next.providerId, model: next.model, voice: next.voices.includes(chosen?.voice ?? "") ? chosen!.voice : next.voices[0]! } : null });
            }}
          />
          {chosen && model && (
            <Dropdown<string>
              label={t("settings.cloudVoiceVoice")}
              search={model.voices.length > 12 ? t("settings.cloudVoiceSearch") : undefined}
              value={chosen.voice}
              options={model.voices.map((v) => ({ value: v, label: v }))}
              onChange={(voice) => {
                setProblem(null);
                void updateSettings({ cloudVoice: { ...chosen, voice } });
              }}
            />
          )}
          {chosen && (
            <button type="button" className="btn" disabled={state === "loading"} onClick={() => void sample()}>
              {t(state === "loading" ? "voice.preparing" : state === "playing" ? "voice.silence" : "settings.cloudVoiceListen")}
            </button>
          )}
        </div>
      )}
      {problem && (
        <p className="muted" role="status">
          {problem}
        </p>
      )}
    </Setting>
  );
}
