import { useRef, useState } from "react";
import { useApp } from "../../context";

const WIDTH_KEY = "drimvox.resultWidth";
const DEFAULT_WIDTH = 480;
/** Narrower than this, the panel is not worth showing: let go there and it closes. */
const CLOSE_BELOW = 180;
const MIN_WIDTH = 300;
/** The work in the middle keeps at least this much. */
const MAIN_MIN = 380;
const STEP = 40;

function kept(): { width: number; last: number } {
  try {
    const [width, last] = (localStorage.getItem(WIDTH_KEY) ?? "").split(",").map(Number);
    if (width !== undefined && last !== undefined && Number.isFinite(width) && last > 0) return { width, last };
  } catch {
    // No storage: the default.
  }
  return { width: DEFAULT_WIDTH, last: DEFAULT_WIDTH };
}

/** The result panel's width, remembered: 0 when folded away, with the width it had to come back to. */
export function useResultWidth() {
  const [state, setState] = useState(kept);
  const [dragging, setDragging] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const set = (width: number) => {
    const next = { width, last: width > 0 ? width : state.last };
    setState(next);
    try {
      localStorage.setItem(WIDTH_KEY, `${next.width},${next.last}`);
    } catch {
      // Kept for this visit only.
    }
  };
  /** A wished width as the panel can have it: closed below the edge, at least its minimum, the middle kept readable. */
  const fit = (wish: number) => {
    const room = (body.current?.getBoundingClientRect().width ?? 1200) - MAIN_MIN;
    if (wish < CLOSE_BELOW) return 0;
    return Math.round(Math.max(MIN_WIDTH, Math.min(wish, room)));
  };
  return { width: state.width, last: state.last, set, fit, dragging, setDragging, body, toggle: () => set(state.width > 0 ? 0 : fit(state.last)) };
}

/**
 * The handle between the work and the result (asked for: a slider, not a button): dragged, it sets the panel's width
 * and folds it away at the edge; clicked, it opens or folds the panel, which slides; the arrow keys move it too.
 */
export function ResultSplit({ split }: { split: ReturnType<typeof useResultWidth> }) {
  const { t } = useApp();
  const start = useRef<{ x: number; moved: boolean } | null>(null);
  const open = split.width > 0;
  const widthAt = (x: number) => (split.body.current?.getBoundingClientRect().right ?? x) - x - 6;
  return (
    <div className={`workshop-split${open ? "" : " is-closed"}`}>
      <button
        type="button"
        className="workshop-grip"
        aria-label={t(open ? "workshop.hideResult" : "workshop.showResult")}
        aria-expanded={open}
        aria-controls="workshop-result"
        title={t("workshop.gripHint")}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { x: e.clientX, moved: false };
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          if (!start.current.moved && Math.abs(e.clientX - start.current.x) < 4) return;
          if (!start.current.moved) split.setDragging(true);
          start.current.moved = true;
          split.set(split.fit(widthAt(e.clientX)));
        }}
        onPointerUp={() => {
          const moved = start.current?.moved;
          start.current = null;
          split.setDragging(false);
          if (!moved) split.toggle();
        }}
        onPointerCancel={() => {
          start.current = null;
          split.setDragging(false);
        }}
        onClick={(e) => {
          // A keyboard's Enter or Space: pointer clicks are handled on the way up.
          if (e.detail === 0) split.toggle();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") split.set(split.fit((open ? split.width : CLOSE_BELOW) + STEP));
          else if (e.key === "ArrowRight") split.set(split.fit(split.width - STEP));
          else return;
          e.preventDefault();
        }}
      >
        <span aria-hidden />
        <span aria-hidden />
        <span aria-hidden />
      </button>
    </div>
  );
}
