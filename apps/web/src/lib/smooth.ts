import { useEffect, useRef, useState } from "react";

/** What has come is all shown this long after it came. */
const CATCH_UP_MS = 400;
/** The least speed, letters per millisecond, so the last few letters do not crawl. */
const MIN_RATE = 0.06;
/** Drawn every frame, so the letters come one or two at a time, as on DeepSeek's own site (seen: words at a time). */
const FRAME_MS = 0;

/**
 * An answer being written, shown letter by letter instead of in the pieces the provider sends (seen: it jerked). The
 * speed follows what is waiting: the faster the model writes, the faster the letters come. A finished answer, or one
 * that was never streamed, shows whole at once.
 */
export function useSmoothText(text: string, live: boolean): string {
  const [shown, setShown] = useState(live ? "" : text);
  const length = useRef(shown.length);
  const target = useRef(text);
  target.current = text;

  useEffect(() => {
    if (!live) {
      length.current = text.length;
      setShown(text);
    }
  }, [live, text]);

  useEffect(() => {
    if (!live) return;
    let frame = 0;
    let last = performance.now();
    let drawn = last;
    let known = -1;
    let rate = MIN_RATE;
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      const full = target.current;
      // The text was replaced (a new answer in the same place): start over from it.
      if (length.current > full.length) length.current = 0;
      const behind = full.length - length.current;
      // A new piece came: the speed is set so that everything waiting is shown in CATCH_UP_MS, evenly.
      if (full.length !== known) {
        known = full.length;
        rate = Math.max(MIN_RATE, behind / CATCH_UP_MS);
      }
      if (behind > 0) {
        length.current = Math.min(full.length, length.current + Math.max(1, Math.round(rate * dt)));
        if (now - drawn >= FRAME_MS || length.current === full.length) {
          drawn = now;
          setShown(full.slice(0, length.current));
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [live]);

  return live ? shown : text;
}
