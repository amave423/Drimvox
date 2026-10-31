import { useEffect, useState, type RefObject } from "react";
import { useApp } from "../../context";

/**
 * The user's own messages as marks along the conversation (asked for: like in DeepSeek and Codex): each mark is one
 * question; hovered it shows the question's start, clicked it brings the question into view. The one in view is marked.
 */
export function MessageRail({ texts, list }: { texts: string[]; list: RefObject<HTMLDivElement | null> }) {
  const { t } = useApp();
  const [current, setCurrent] = useState(-1);

  // Which question is in view: the last one whose top has passed the top third of the window.
  useEffect(() => {
    const root = list.current;
    if (!root) return;
    const scroller = root.closest(".desk, .workshop-chat-body, .sheet-scroll") ?? document.scrollingElement;
    const look = () => {
      const marks = [...root.querySelectorAll(".msg-user-wrap")];
      const line = window.innerHeight / 3;
      let found = -1;
      marks.forEach((el, i) => {
        if (el.getBoundingClientRect().top < line) found = i;
      });
      setCurrent(found === -1 && marks.length ? 0 : found);
    };
    look();
    const target: EventTarget = scroller === document.scrollingElement ? window : (scroller ?? window);
    target.addEventListener("scroll", look, { passive: true, capture: true } as AddEventListenerOptions);
    return () => target.removeEventListener("scroll", look, { capture: true } as EventListenerOptions);
  }, [list, texts.length]);

  if (texts.length < 2) return null;
  const go = (i: number) => {
    const marks = list.current?.querySelectorAll(".msg-user-wrap");
    marks?.[i]?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return (
    <nav className="msg-rail" aria-label={t("chat.yourMessages")}>
      {texts.map((text, i) => (
        <button key={i} type="button" className={`msg-rail-mark${i === current ? " is-on" : ""}`} onClick={() => go(i)} aria-label={text.slice(0, 80)} aria-current={i === current || undefined}>
          <span className="msg-rail-line" aria-hidden />
          <span className="msg-rail-text">{text.replace(/\s+/g, " ").slice(0, 90)}</span>
        </button>
      ))}
    </nav>
  );
}
