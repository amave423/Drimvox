import { useEffect, useRef, useState } from "react";
import { useApp } from "../../context";
import { speak, startRecording, plainText, speakPieces, speechChunks } from "../../lib/recorder";

/**
 * Dictation in the message box (asked for): press, speak, press again; the voice model from the settings writes it down
 * and the text joins what is in the box. Explained when no voice model is chosen.
 */
export function DictateButton({ onText, disabled }: { onText(text: string): void; disabled?: boolean }) {
  const { api, t } = useApp();
  const [state, setState] = useState<"idle" | "recording" | "writing">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const stop = useRef<(() => Promise<string>) | null>(null);

  async function toggle() {
    setProblem(null);
    if (state === "recording" && stop.current) {
      setState("writing");
      try {
        const audio = await stop.current();
        const res = await api.voice.transcribe.$post({ json: { audio, mimeType: "audio/wav" } });
        const body = (await res.json().catch(() => null)) as { text?: string; error?: { code?: string } } | null;
        if (res.ok && body?.text) onText(body.text);
        else setProblem(body?.error?.code === "no_voice_model" ? t("voice.noModel") : t("voice.failed"));
      } catch {
        setProblem(t("voice.failed"));
      }
      stop.current = null;
      setState("idle");
      return;
    }
    try {
      stop.current = await startRecording();
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
  if (typeof speechSynthesis === "undefined" && !settings.speechVoice) return null;
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
          if (settings.speechVoice) {
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
