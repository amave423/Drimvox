import type { CloudSpeechModel, LocalSpeechStatus, LocalVoiceId } from "@drimvox/shared";
import { useEffect, useRef, useState } from "react";
import { authHeaders, ok } from "../api";
import { useApp } from "../context";
import { Setting } from "./Setting";

/** Where the voices come from: this computer (the system's and Piper's), or a provider's speech models. */
const HERE = "here";

interface Voice {
  key: string;
  label: string;
  /** The model's name, as a heading over its voices; absent on this computer. */
  group?: string;
  pick: { speechVoice: LocalVoiceId | null; cloudVoice: { providerId: string; model: string; voice: string } | null };
}

/**
 * Which voice reads answers aloud, all in one list as the dictation's models are (asked for: the computer's voices and
 * the providers' were two settings): the sources on the left, this computer first, their voices on the right, a sample
 * to hear the chosen one (docs/specs/local-speech.md).
 */
export function SpeechVoiceSetting() {
  const { api, t, settings, updateSettings, navigate, token } = useApp();
  const [status, setStatus] = useState<LocalSpeechStatus | null>(null);
  const [models, setModels] = useState<CloudSpeechModel[] | null>(null);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<string>(settings.cloudVoice?.providerId ?? HERE);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => () => audio.current?.pause(), []);
  useEffect(() => {
    void api.local.speech
      .$get()
      .then((r) => ok<LocalSpeechStatus>(r))
      .then(setStatus)
      .catch(() => setStatus(null));
    void fetch("/api/voice/cloud", { headers: authHeaders(token) })
      .then((r) => (r.ok ? (r.json() as Promise<CloudSpeechModel[]>) : []))
      .then(setModels)
      .catch(() => setModels([]));
  }, [api, token]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const here: Voice[] = [
    { key: "system", label: t("settings.speechVoiceSystem"), pick: { speechVoice: null, cloudVoice: null } },
    ...(status?.voices.filter((v) => v.installed) ?? []).map((v) => ({ key: `piper|${v.id}`, label: v.name, pick: { speechVoice: v.id, cloudVoice: null } })),
  ];
  const providers = [...new Map((models ?? []).map((m) => [m.providerId, m.provider])).entries()];
  const voicesOf = (providerId: string): Voice[] =>
    (models ?? [])
      .filter((m) => m.providerId === providerId)
      .flatMap((m) =>
        m.voices.map((voice) => ({
          key: `${m.providerId}|${m.model}|${voice}`,
          label: voice,
          group: m.free ? `${m.name} · ${t("settings.cloudVoiceFree")}` : m.name,
          pick: { speechVoice: settings.speechVoice, cloudVoice: { providerId: m.providerId, model: m.model, voice } },
        })),
      );
  const chosenKey = settings.cloudVoice
    ? `${settings.cloudVoice.providerId}|${settings.cloudVoice.model}|${settings.cloudVoice.voice}`
    : settings.speechVoice
      ? `piper|${settings.speechVoice}`
      : "system";
  const all = [...here, ...providers.flatMap(([id]) => voicesOf(id))];
  const chosen = all.find((v) => v.key === chosenKey);
  const chosenSource = settings.cloudVoice ? providers.find(([id]) => id === settings.cloudVoice!.providerId)?.[1] : t("settings.voiceHere");
  const q = query.trim().toLowerCase();
  const list = (source === HERE ? here : voicesOf(source)).filter((v) => !q || v.label.toLowerCase().includes(q) || v.group?.toLowerCase().includes(q));

  async function sample() {
    if (state === "playing") {
      audio.current?.pause();
      setState("idle");
      return;
    }
    setProblem(null);
    setState("loading");
    try {
      const res = await fetch("/api/voice/speak", {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify({ text: t("settings.cloudVoiceSample") }),
      });
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
    <Setting id="speech-voice-label" title={t("settings.speechVoice")} about={t("settings.speechVoiceHint")}>
      <div className="speech-voice">
        <div className="picker" ref={root}>
          <button type="button" className="picker-button" aria-expanded={open} aria-labelledby="speech-voice-label" onClick={() => setOpen(!open)}>
            <span className="picker-label">
              {chosen?.label ?? settings.cloudVoice?.voice ?? t("settings.speechVoiceSystem")}
              {chosenSource && <span className="picker-label-provider">{chosenSource}</span>}
            </span>
            <span aria-hidden>▾</span>
          </button>
          {open && (
            <div className="picker-panel model-panel has-providers voice-panel">
              <nav className="picker-providers" aria-label={t("settings.voiceSources")}>
                <button type="button" className={source === HERE ? "is-on" : undefined} onClick={() => setSource(HERE)}>
                  {t("settings.voiceHere")}
                </button>
                {providers.length > 0 && <span className="picker-providers-h">{t("settings.voiceCloud")}</span>}
                {providers.map(([id, name]) => (
                  <button type="button" key={id} className={source === id ? "is-on" : undefined} onClick={() => setSource(id)}>
                    {name}
                  </button>
                ))}
                {models === null && <span className="picker-providers-h">{t("settings.cloudVoiceLooking")}</span>}
              </nav>
              <div className="picker-main">
                <input
                  className="field-input"
                  placeholder={t("settings.cloudVoiceSearch")}
                  aria-label={t("settings.cloudVoiceSearch")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoFocus
                />
                <ul className="picker-list" role="listbox" aria-label={t("settings.speechVoice")}>
                  {list.map((v, i) => (
                    <VoiceItem
                      key={v.key}
                      voice={v}
                      heading={v.group && v.group !== list[i - 1]?.group ? v.group : undefined}
                      chosen={v.key === chosenKey}
                      onPick={() => {
                        setProblem(null);
                        setOpen(false);
                        void updateSettings(v.pick);
                      }}
                    />
                  ))}
                </ul>
                {source === HERE && (
                  <button type="button" className="link voice-more" onClick={() => navigate({ kind: "local", part: "audio" })}>
                    {t(here.length > 1 ? "settings.speechVoiceMore" : "settings.speechVoiceGet")}
                  </button>
                )}
                {source === HERE && models?.length === 0 && <p className="muted">{t("settings.cloudVoiceNone")}</p>}
              </div>
            </div>
          )}
        </div>
        {(settings.speechVoice || settings.cloudVoice) && (
          <button type="button" className="btn" disabled={state === "loading"} onClick={() => void sample()}>
            {t(state === "loading" ? "voice.preparing" : state === "playing" ? "voice.silence" : "settings.cloudVoiceListen")}
          </button>
        )}
      </div>
      {problem && (
        <p className="muted" role="status">
          {problem}
        </p>
      )}
    </Setting>
  );
}

function VoiceItem({ voice, heading, chosen, onPick }: { voice: Voice; heading?: string; chosen: boolean; onPick(): void }) {
  return (
    <>
      {heading && (
        <li role="presentation" className="picker-group">
          {heading}
        </li>
      )}
      <li role="option" className="picker-item" aria-selected={chosen}>
        <button type="button" onClick={onPick}>
          <span className="picker-name">{voice.label}</span>
        </button>
      </li>
    </>
  );
}
