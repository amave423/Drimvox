import { useEffect, useRef, useState } from "react";
import { useApp } from "../../context";
import { dictionaries, type MessageKey } from "../../i18n";
import { speak, startRecording, plainText, speakPieces, speechChunks, type Recording } from "../../lib/recorder";
import { playCue } from "../../lib/sounds";

/** Bars in the live wave of a recording. */
const BARS = 28;

/** The recording as it happens: a beating dot, the time and a wave of the voice running right to left. */
function RecordingWave({ recording, onStop }: { recording: Recording; onStop(): void }) {
  const { t } = useApp();
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = performance.now();
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      // A new bar every 70 ms: fast enough to follow the voice, slow enough to read as a wave.
      if (now - last > 70) {
        last = now;
        const level = recording.level();
        setLevels((old) => [...old.slice(1), level]);
        setSeconds(Math.floor((now - started) / 1000));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [recording]);
  return (
    <button type="button" className="dictate-live" onClick={onStop} aria-label={t("voice.stop")} title={t("voice.stop")}>
      <span className="dictate-dot" aria-hidden />
      <span className="dictate-wave" aria-hidden>
        {levels.map((v, i) => (
          <span key={i} style={{ transform: `scaleY(${Math.max(0.08, v)})` }} />
        ))}
      </span>
      <span className="dictate-time mono">
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </span>
    </button>
  );
}

/**
 * Dictation in the message box (asked for): press, speak, press again; the voice model from the settings writes it down
 * and the text joins what is in the box. Explained when no voice model is chosen.
 */
export function DictateButton({ onText, disabled }: { onText(text: string): void; disabled?: boolean }) {
  const { api, t, settings } = useApp();
  const [state, setState] = useState<"idle" | "recording" | "writing">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const stop = useRef<(() => Promise<string>) | null>(null);
  const volume = settings.notifyVolume || 0.6;

  async function toggle() {
    setProblem(null);
    if (state === "recording" && stop.current) {
      setState("writing");
      setRecording(null);
      playCue("stop", volume);
      try {
        const audio = await stop.current();
        const res = await api.voice.transcribe.$post({ json: { audio, mimeType: "audio/wav" } });
        const body = (await res.json().catch(() => null)) as { text?: string; error?: { code?: string; detail?: string } } | null;
        if (res.ok && body?.text) onText(body.text);
        else {
          const code = body?.error?.code;
          // The provider's own words say what went wrong (seen: only "could not recognise", whatever the reason).
          const detail = body?.error?.detail ? ` ${body.error.detail}` : "";
          // The provider's problem in the interface's words where there are some (seen: OpenRouter takes audio only with
          // $0.50 on the account, free models too).
          const known = code && `error.${code}` in dictionaries.ru && code !== "unknown" ? ` ${t(`error.${code}` as MessageKey)}` : "";
          setProblem(code === "no_voice_model" ? t("voice.noModel") : code === "nothing_heard" ? t("voice.nothingHeard") : `${t("voice.failed")}${known}${detail}`);
        }
      } catch {
        setProblem(t("voice.failed"));
      }
      stop.current = null;
      setState("idle");
      return;
    }
    try {
      const started = await startRecording();
      stop.current = started.stop;
      setRecording(started);
      playCue("start", volume);
      setState("recording");
    } catch {
      setProblem(t("voice.noMicrophone"));
    }
  }

  const label = t(state === "recording" ? "voice.stop" : state === "writing" ? "voice.writing" : "voice.dictate");
  return (
    <span className="dictate">
      <button
        type="button"
        className={`attach-button${state === "recording" ? " is-recording" : ""}`}
        aria-label={label}
        title={label}
        disabled={disabled || state === "writing"}
        onClick={() => void toggle()}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      </button>
      {recording && <RecordingWave recording={recording} onStop={() => void toggle()} />}
      {state === "writing" && (
        <span className="dictate-writing muted" role="status">
          <span className="action-spinner" aria-hidden />
          {t("voice.writing")}
        </span>
      )}
      {problem && (
        <span className="dictate-problem" role="status">
          {problem}
        </span>
      )}
    </span>
  );
}

/** An answer read aloud with the system's voices (asked for); pressed again, it stops. */
export function SpeakButton({ text }: { text: string }) {
  const { api, t, settings } = useApp();
  const [on, setOn] = useState(false);
  // The voice is being made and nothing is heard yet (asked for: it looked as if it had hung).
  const [preparing, setPreparing] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  // A voice made by the core: a Piper one on this computer, or a provider's from the cloud.
  const madeVoice = !!settings.speechVoice || !!settings.cloudVoice;
  if (typeof speechSynthesis === "undefined" && !madeVoice) return null;
  const label = t(preparing ? "voice.preparing" : on ? "voice.silence" : "voice.listen");
  return (
    <>
      <button
        type="button"
        className="msg-tool msg-speak"
        aria-label={label}
        title={label}
        aria-pressed={on}
        aria-busy={preparing}
        onClick={() => {
          if (on) return stop.current?.();
          setOn(true);
          const done = () => {
            setOn(false);
            setPreparing(false);
          };
          const system = () => speak(text, settings.locale, done);
          // A Piper voice from the settings reads it on this computer (asked for: the system's voice sounded like a robot),
          // in pieces: the first is heard in seconds while the rest is made.
          if (madeVoice) {
            setPreparing(true);
            stop.current = speakPieces(
              speechChunks(plainText(text)),
              async (piece) => {
                const res = await api.voice.speak.$post({ json: { text: piece } });
                if (!res.ok) throw new Error(String(res.status));
                return res.blob();
              },
              system,
              () => setPreparing(false),
              done,
            );
          } else stop.current = system();
        }}
      >
        {preparing ? (
          <span className="action-spinner" aria-hidden />
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 9v6h4l5 4V5L8 9H4z" />
            {on ? <path d="M17 9l4 6M21 9l-4 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
          </svg>
        )}
      </button>
      {preparing && (
        <span className="muted msg-speak-note" role="status">
          {t("voice.preparing")}
        </span>
      )}
    </>
  );
}
