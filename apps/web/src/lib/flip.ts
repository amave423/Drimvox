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
}

/** A menu `width` wide by its button, on the window: under or over it, moved left as far as it must to stay inside. */
export function fixedBy(place: Place, width: number): CSSProperties | undefined {
  if (!place.rect) return undefined;
  const left = Math.max(16, Math.min(place.rect.left, window.innerWidth - 16 - width));
  return place.above
    ? { position: "fixed", left, right: "auto", top: "auto", bottom: window.innerHeight - place.rect.top + 6 }
    : { position: "fixed", left, right: "auto", top: place.rect.bottom + 6, bottom: "auto" };
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
  const [place, setPlace] = useState<Place>({ above: preferAbove, maxHeight: undefined, rect: null });
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const below = window.innerHeight - BOTTOM - r.bottom - 8;
    const over = r.top - TOP - 8;
    const above = preferAbove ? over >= ENOUGH || over > below : below < ENOUGH && over > below;
    setPlace({ above, maxHeight: Math.max(200, Math.floor(above ? over : below)), rect: r });
  }, [open, anchor, preferAbove]);
  return place;
}
