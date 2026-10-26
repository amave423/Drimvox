import type { LocalSpeechStatus, LocalVoiceId } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../api";
import { useApp } from "../context";
import { Segmented } from "./Segmented";
import { Setting } from "./Setting";

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
