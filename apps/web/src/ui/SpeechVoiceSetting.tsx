import { cloudVoices, type LocalSpeechStatus, type LocalVoiceId } from "@drimvox/shared";
import { useEffect, useRef, useState } from "react";
import { ok } from "../api";
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
 * A provider's voice that reads answers instead of the Piper or system one (asked for: voices from the cloud): Gemini's
 * and OpenAI's voices of the providers connected, and a sample to hear it before choosing.
 */
export function CloudVoiceSetting() {
  const { api, t, settings, updateSettings, providers } = useApp();
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const options = providers.flatMap((p) =>
    p.preset === "google" || p.preset === "openai"
      ? cloudVoices[p.preset].map((v) => ({ value: `${p.id}|${v.id}`, label: `${v.id} · ${p.name}`, hint: t(`settings.cloudVoiceKind.${v.kind}`) }))
      : [],
  );
  const chosen = settings.cloudVoice ? `${settings.cloudVoice.providerId}|${settings.cloudVoice.voice}` : NONE;

  async function sample() {
    if (state === "playing") {
      audio.current?.pause();
      setState("idle");
      return;
    }
    setProblem(null);
    setState("loading");
    try {
      const res = await api.voice.speak.$post({ json: { text: t("settings.cloudVoiceSample") } });
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
      {options.length === 0 ? (
        <p className="muted">{t("settings.cloudVoiceNone")}</p>
      ) : (
        <div className="speech-voice">
          <Dropdown<string>
            label={t("settings.cloudVoice")}
            value={chosen}
            options={[{ value: NONE, label: t("settings.cloudVoiceOff") }, ...options]}
            onChange={(value) => {
              setProblem(null);
              const [providerId, voice] = value.split("|");
              void updateSettings({ cloudVoice: value === NONE || !providerId || !voice ? null : { providerId, voice } });
            }}
          />
          {settings.cloudVoice && (
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
