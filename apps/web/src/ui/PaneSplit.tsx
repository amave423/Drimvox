import { useRef, useState } from "react";
import { useApp } from "../context";
import type { MessageKey } from "../i18n";

const STEP = 40;

/** A pane beside the main column: where it stands, its widths, and where its width is remembered. */
export interface PaneShape {
  key: string;
  /** The pane's side of the handle: the result panel is on the right of it, the sidebar on the left. */
  side: "left" | "right";
  initial: number;
  min: number;
  /** Narrower than this, the pane is not worth showing: let go there and it closes. */
  closeBelow: number;
  /** The main column keeps at least this much. */
  mainMin: number;
}

/** The workshop's result panel. */
export const RESULT_PANE: PaneShape = { key: "drimvox.resultWidth", side: "right", initial: 480, min: 300, closeBelow: 180, mainMin: 380 };
/** The sidebar: the chats or the projects (asked for: its width set by the same handle). */
export const SIDE_PANE: PaneShape = { key: "drimvox.sideWidth", side: "left", initial: 264, min: 200, closeBelow: 120, mainMin: 560 };

function kept(shape: PaneShape): { width: number; last: number } {
  try {
    const [width, last] = (localStorage.getItem(shape.key) ?? "").split(",").map(Number);
    if (width !== undefined && last !== undefined && Number.isFinite(width) && last > 0) return { width, last };
  } catch {
    // No storage: the default.
  }
  return { width: shape.initial, last: shape.initial };
}

/** A pane's width, remembered: 0 when folded away, with the width it had to come back to. */
export function usePaneWidth(shape: PaneShape = RESULT_PANE) {
  const [state, setState] = useState(() => kept(shape));
  const [dragging, setDragging] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const set = (width: number) => {
    const next = { width, last: width > 0 ? width : state.last };
    setState(next);
    try {
      localStorage.setItem(shape.key, `${next.width},${next.last}`);
    } catch {
      // Kept for this visit only.
    }
  };
  /** A wished width as the panel can have it: closed below the edge, at least its minimum, the middle kept readable. */
  const fit = (wish: number) => {
    const room = (body.current?.getBoundingClientRect().width ?? 1200) - shape.mainMin;
    if (wish < shape.closeBelow) return 0;
    return Math.round(Math.max(shape.min, Math.min(wish, room)));
  };
  /** The width the pointer at `x` asks for: from the far edge of the pane to the handle's middle. */
  const widthAt = (x: number) => {
    const box = body.current?.getBoundingClientRect();
    if (!box) return state.width;
    return shape.side === "right" ? box.right - x - 6 : x - box.left - 6;
  };
  return { shape, width: state.width, last: state.last, set, fit, widthAt, dragging, setDragging, body, toggle: () => set(state.width > 0 ? 0 : fit(state.last)) };
}

export type Pane = ReturnType<typeof usePaneWidth>;

/**
 * The handle beside a pane (asked for: a slider, not a button): dragged, it sets the pane's width and folds it away at
 * the edge; clicked, it opens or folds the pane, which slides; the arrow keys move it too.
 */
export function PaneSplit({ split, label, controls }: { split: Pane; label: { open: MessageKey; closed: MessageKey }; controls: string }) {
  const { t } = useApp();
  const start = useRef<{ x: number; moved: boolean; grip: boolean } | null>(null);
  // Where the grip stands along the strip: where it was last taken (asked for: anywhere, not only in the middle).
  const [gripY, setGripY] = useState<number | null>(null);
  const open = split.width > 0;
  // The arrow towards the pane widens it.
  const wider = split.shape.side === "right" ? "ArrowLeft" : "ArrowRight";
  const narrower = split.shape.side === "right" ? "ArrowRight" : "ArrowLeft";
  const follow = (strip: HTMLElement, y: number) => {
    const box = strip.getBoundingClientRect();
    setGripY(Math.min(Math.max(y - box.top, 28), box.height - 28));
  };
  return (
    // The whole strip takes the pointer: taken anywhere, it drags, and the grip comes to where it was taken; a click on
    // the grip itself, without dragging, opens or folds the pane.
    <div
      className={`workshop-split${open ? "" : " is-closed"}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const grip = (e.target as HTMLElement).closest(".workshop-grip") !== null;
        start.current = { x: e.clientX, moved: false, grip };
        follow(e.currentTarget, e.clientY);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        follow(e.currentTarget, e.clientY);
        if (!start.current.moved && Math.abs(e.clientX - start.current.x) < 4) return;
        if (!start.current.moved) split.setDragging(true);
        start.current.moved = true;
        split.set(split.fit(split.widthAt(e.clientX)));
      }}
      onPointerUp={() => {
        const taken = start.current;
        start.current = null;
        split.setDragging(false);
        if (taken?.grip && !taken.moved) split.toggle();
      }}
      onPointerCancel={() => {
        start.current = null;
        split.setDragging(false);
      }}
    >
      <button
        type="button"
        className="workshop-grip"
        style={gripY === null ? undefined : { top: gripY }}
        aria-label={t(open ? label.open : label.closed)}
        aria-expanded={open}
        aria-controls={controls}
        title={t("workshop.gripHint")}
        onClick={(e) => {
          // A keyboard's Enter or Space: pointer clicks are handled on the way up.
          if (e.detail === 0) split.toggle();
        }}
        onKeyDown={(e) => {
          if (e.key === wider) split.set(split.fit((open ? split.width : split.shape.closeBelow) + STEP));
          else if (e.key === narrower) split.set(split.fit(split.width - STEP));
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
