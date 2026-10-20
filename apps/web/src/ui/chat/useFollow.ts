import { useEffect, useRef, type RefObject } from "react";

/**
 * A new message always brings the view down; a growing answer is followed only while the reader is at the bottom, so
 * scrolling up to read is not undone with every word. The desk itself scrolls to its very end: aligning the last line
 * with the window's edge hid it under the composer (seen: the bottom could not be reached).
 */
export function useFollow(end: RefObject<HTMLDivElement | null>, list: RefObject<HTMLDivElement | null>, chatId: string | undefined, newMessage: unknown[]) {
  const following = useRef(true);
  const desk = () => end.current?.closest<HTMLElement>(".desk") ?? null;
  const toBottom = () => {
    const d = desk();
    if (d) d.scrollTop = d.scrollHeight;
  };
  useEffect(() => {
    const d = desk();
    if (!d) return;
    const onScroll = () => {
      following.current = d.scrollHeight - d.scrollTop - d.clientHeight < 80;
    };
    // Opening the thinking or the actions of an answer is reading: the view stays there instead of running to the
    // bottom with the next words (seen: the opened thinking slid away while the answer was written).
    // The click itself, not the "toggle" that follows it: a scroll already on its way would still run in between.
    const onOpen = (e: Event) => {
      if (e.target instanceof Element && e.target.closest(".messages summary")) following.current = false;
    };
    d.addEventListener("scroll", onScroll, { passive: true });
    d.addEventListener("pointerdown", onOpen, true);
    d.addEventListener("keydown", onOpen, true);
    return () => {
      d.removeEventListener("scroll", onScroll);
      d.removeEventListener("pointerdown", onOpen, true);
      d.removeEventListener("keydown", onOpen, true);
    };
  }, [chatId]);
  useEffect(() => {
    following.current = true;
    toBottom();
  }, newMessage);
  // The answer grows letter by letter, after its pieces have come too (lib/smooth.ts): the view follows the messages'
  // own height, not the pieces (seen: the last line stayed under the composer).
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    let frame = 0;
    const watch = new ResizeObserver(() => {
      if (!following.current) return;
      cancelAnimationFrame(frame);
      // Asked again when the frame comes: the reader may have opened something in between.
      frame = requestAnimationFrame(() => following.current && toBottom());
    });
    watch.observe(el);
    return () => {
      watch.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [chatId]);
}
