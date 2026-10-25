import { useLayoutEffect, useState, type RefObject } from "react";

/** The window's own bars, top and bottom: a menu does not go under them. */
const TOP = 52;
const BOTTOM = 40;
/** A menu shorter than this is cramped: it opens where there is more room instead. */
const ENOUGH = 360;

/**
 * Where a menu opens: below its button when there is room, above when there is more there, never past the window, with
 * its height kept to the room it has (seen again and again: a menu fixed to open downwards ran off the window).
 */
export function useFlip(open: boolean, anchor: RefObject<HTMLElement | null>, preferAbove = false): { above: boolean; maxHeight: number | undefined } {
  const [place, setPlace] = useState<{ above: boolean; maxHeight: number | undefined }>({ above: preferAbove, maxHeight: undefined });
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const below = window.innerHeight - BOTTOM - r.bottom - 8;
    const over = r.top - TOP - 8;
    const above = preferAbove ? over >= ENOUGH || over > below : below < ENOUGH && over > below;
    setPlace({ above, maxHeight: Math.max(200, Math.floor(above ? over : below)) });
  }, [open, anchor, preferAbove]);
  return place;
}
