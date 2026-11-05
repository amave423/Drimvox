import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/** The window's own bars, top and bottom: a menu does not go under them. */
const TOP = 52;
const BOTTOM = 40;
/** A menu shorter than this is cramped: it opens where there is more room instead. */
const ENOUGH = 360;

interface Place {
  above: boolean;
  maxHeight: number | undefined;
  /** The button, on the window, for a menu placed over everything (fixed) rather than inside its column. */
  rect: DOMRect | null;
  /** What the menu may cover sideways: the column that clips it (the desk) or the window. */
  room: { left: number; right: number } | null;
}

/**
 * A menu `width` wide by its button: under or over it, moved left as far as it must to stay inside the column that
 * clips it, and narrowed to that column (seen: in a project the model list went under the sidebar on its left).
 */
export function fixedBy(place: Place, width: number): CSSProperties | undefined {
  if (!place.rect) return undefined;
  const room = place.room ?? { left: 0, right: window.innerWidth };
  const fits = Math.min(width, room.right - room.left - 16);
  const left = Math.max(room.left + 8, Math.min(place.rect.left, room.right - 8 - fits));
  const across = { position: "fixed" as const, left, right: "auto", width: fits };
  return place.above ? { ...across, top: "auto", bottom: window.innerHeight - place.rect.top + 6 } : { ...across, top: place.rect.bottom + 6, bottom: "auto" };
}

/**
 * A fixed menu inside a box that holds fixed elements itself (layout containment: the desk is a container) is placed
 * from that box, not the window: once shown, it is moved by the difference so it stands where `fixedBy` meant.
 */
export function useOnWindow(panel: RefObject<HTMLElement | null>, style: CSSProperties | undefined) {
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || !style || style.position !== "fixed") return;
    const r = el.getBoundingClientRect();
    // Moved by what is still off, from where it stands now: the same each time it runs.
    const by = (side: "left" | "top" | "bottom", off: number) => {
      if (Math.abs(off) > 0.5) el.style[side] = `${parseFloat(el.style[side]) + off}px`;
    };
    if (typeof style.left === "number") by("left", style.left - r.left);
    if (typeof style.top === "number") by("top", style.top - r.top);
    if (typeof style.bottom === "number") by("bottom", style.bottom - (window.innerHeight - r.bottom));
  });
}

/**
 * Where a menu opens: below its button when there is room, above when there is more there, never past the window, with
 * its height kept to the room it has (seen again and again: a menu fixed to open downwards ran off the window).
 */
export function useFlip(open: boolean, anchor: RefObject<HTMLElement | null>, preferAbove = false): Place {
  const [place, setPlace] = useState<Place>({ above: preferAbove, maxHeight: undefined, rect: null, room: null });
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const below = window.innerHeight - BOTTOM - r.bottom - 8;
    const over = r.top - TOP - 8;
    const above = preferAbove ? over >= ENOUGH || over > below : below < ENOUGH && over > below;
    // The desk is a container: a fixed menu inside it is clipped by its edges, not the window's.
    const desk = anchor.current.closest(".desk")?.getBoundingClientRect();
    setPlace({ above, maxHeight: Math.max(200, Math.floor(above ? over : below)), rect: r, room: desk ? { left: desk.left, right: desk.right } : null });
  }, [open, anchor, preferAbove]);
  return place;
}
