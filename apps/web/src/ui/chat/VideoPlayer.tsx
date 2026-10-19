import { useEffect, useRef, useState } from "react";
import { useApp } from "../../context";

const time = (s: number) => {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

function Icon({ name }: { name: "play" | "pause" | "sound" | "mute" | "full" }) {
  const paths = {
    play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" />,
    pause: <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />,
    sound: <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
    mute: <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9.5l5 5M21 9.5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
    full: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  };
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      {paths[name]}
    </svg>
  );
}

/**
 * Artel's own player for clips (seen: the browser's stock controls looked out of place): a big play button, then a
 * bar with play, time, a seek line, sound and full screen. Space plays and pauses while the player has the focus.
 */
export function VideoPlayer({ src, label }: { src: string; label: string }) {
  const { t } = useApp();
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  const [length, setLength] = useState(0);
  const [muted, setMuted] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const sync = () => {
      setPlaying(!v.paused);
      setNow(v.currentTime);
      setLength(v.duration || 0);
      setMuted(v.muted);
    };
    const events = ["play", "pause", "timeupdate", "loadedmetadata", "volumechange", "ended"] as const;
    for (const e of events) v.addEventListener(e, sync);
    return () => {
      for (const e of events) v.removeEventListener(e, sync);
    };
  }, [src]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    setStarted(true);
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  return (
    <div
      ref={box}
      className={`player${playing ? " is-playing" : ""}`}
      tabIndex={0}
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === " " && e.target === box.current) {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <video ref={video} src={src} preload="metadata" playsInline onClick={toggle} />
      {!playing && (
        <button type="button" className="player-big" aria-label={t("player.play")} onClick={toggle}>
          <Icon name="play" />
        </button>
      )}
      <div className={`player-bar${started ? "" : " is-quiet"}`}>
        <button type="button" aria-label={t(playing ? "player.pause" : "player.play")} onClick={toggle}>
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <span className="player-time mono">
          {time(now)} / {time(length)}
        </span>
        <input
          className="player-seek"
          type="range"
          min={0}
          max={length || 0}
          step={0.05}
          value={now}
          aria-label={t("player.seek")}
          style={{ ["--done" as string]: `${length ? (now / length) * 100 : 0}%` }}
          onChange={(e) => {
            if (video.current) video.current.currentTime = Number(e.target.value);
          }}
        />
        <button
          type="button"
          aria-label={t(muted ? "player.unmute" : "player.mute")}
          onClick={() => {
            if (video.current) video.current.muted = !video.current.muted;
          }}
        >
          <Icon name={muted ? "mute" : "sound"} />
        </button>
        <button type="button" aria-label={t("player.full")} onClick={() => void box.current?.requestFullscreen?.().catch(() => {})}>
          <Icon name="full" />
        </button>
      </div>
    </div>
  );
}
