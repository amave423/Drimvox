import { useEffect, useRef, useState } from "react";
import type { Mode } from "../context";
import { Logo } from "./Logo";

/** How long the mark is drawn: at the start of the app, and on a change of mode. */
const START_MS = 1700;
const SWITCH_MS = 1000;

const still = () => {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/**
 * The mark drawn over the window (asked for): when the app opens in front (not into the tray), and on a change of mode,
 * in that mode's colours. It never takes a click: the window under it works at once.
 */
export function LogoDraw({ mode }: { mode: Mode }) {
  const [run, setRun] = useState<{ key: number; start: boolean } | null>(() => (document.visibilityState === "visible" && !still() ? { key: 0, start: true } : null));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!still()) setRun({ key: Date.now(), start: false });
  }, [mode]);
  useEffect(() => {
    if (!run) return;
    const timer = setTimeout(() => setRun(null), run.start ? START_MS : SWITCH_MS);
    return () => clearTimeout(timer);
  }, [run]);
  if (!run) return null;
  return (
    <div key={run.key} className={`logo-draw${run.start ? " is-start" : ""}`} aria-hidden>
      <Logo size={run.start ? 112 : 84} draw />
      {run.start && <span className="logo-draw-name">Drimvox</span>}
    </div>
  );
}
