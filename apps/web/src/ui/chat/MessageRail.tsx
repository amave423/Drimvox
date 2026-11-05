import { useEffect, useState, type RefObject } from "react";
import { useApp } from "../../context";

/** Which of the user's messages is in view: the last one whose top has passed the top third of the window. */
function useCurrent(list: RefObject<HTMLDivElement | null>, count: number) {
  const [current, setCurrent] = useState(-1);
  useEffect(() => {
    const root = list.current;
    if (!root) return;
    const scroller = root.closest(".workshop-feed, .desk, .sheet-scroll") ?? document.scrollingElement;
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
  }, [list, count]);
  return current;
}

function goTo(list: RefObject<HTMLDivElement | null>, i: number) {
  list.current?.querySelectorAll(".msg-user-wrap")[i]?.scrollIntoView({ block: "start", behavior: "smooth" });
}

const line = (text: string) => text.replace(/\s+/g, " ").slice(0, 90);

/**
 * The user's own messages along the workshop's conversation, as in DeepSeek (asked for: the marks that each grew a label
 * were awkward). Folded, a short dash per message at the right edge, the one in view longer; hovered or focused, one
 * card with all of them listed, the one in view marked, a click bringing it into view.
 */
export function MessageRail({ texts, list }: { texts: string[]; list: RefObject<HTMLDivElement | null> }) {
  const { t } = useApp();
  const current = useCurrent(list, texts.length);
  if (texts.length < 2) return null;
  return (
    <nav className="msg-rail" aria-label={t("chat.yourMessages")}>
      <div className="msg-rail-marks" aria-hidden>
        {texts.map((_, i) => (
          <span key={i} className={i === current ? "is-on" : undefined} />
        ))}
      </div>
      <ol className="msg-rail-panel">
        {texts.map((text, i) => (
          <li key={i}>
            <button
              type="button"
              className={i === current ? "is-on" : undefined}
              onClick={() => goTo(list, i)}
              aria-current={i === current || undefined}
              title={text.slice(0, 300)}
            >
              {line(text)}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The same messages as a plain list in a chat's margin, under deleting it (asked for: the marks at the edge were
 * awkward, and the margin there stood empty). Always open; the one in view is marked.
 */
export function MessageJump({ texts, list }: { texts: string[]; list: RefObject<HTMLDivElement | null> }) {
  const { t } = useApp();
  const current = useCurrent(list, texts.length);
  if (texts.length < 2) return null;
  return (
    <nav className="msg-jump" aria-label={t("chat.yourMessages")}>
      <span className="muted">{t("chat.yourMessages")}</span>
      <ol>
        {texts.map((text, i) => (
          <li key={i}>
            <button
              type="button"
              className={i === current ? "is-on" : undefined}
              onClick={() => goTo(list, i)}
              aria-current={i === current || undefined}
              title={text.slice(0, 300)}
            >
              {line(text)}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
