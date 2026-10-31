import { useEffect, useState, type RefObject } from "react";
import { useApp } from "../../context";

/** Which of the user's messages is in view: the last one whose top has passed the top third of the window. */
function useCurrent(list: RefObject<HTMLDivElement | null>, count: number) {
  const [current, setCurrent] = useState(-1);
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
  }, [list, count]);
  return current;
}

function goTo(list: RefObject<HTMLDivElement | null>, i: number) {
  list.current?.querySelectorAll(".msg-user-wrap")[i]?.scrollIntoView({ block: "start", behavior: "smooth" });
}

const line = (text: string) => text.replace(/\s+/g, " ").slice(0, 90);

/**
 * The user's own messages as marks along the workshop's timeline (asked for: like in DeepSeek and Codex): each mark is
 * one message; hovered it shows the message's start, clicked it brings the message into view.
 */
export function MessageRail({ texts, list }: { texts: string[]; list: RefObject<HTMLDivElement | null> }) {
  const { t } = useApp();
  const current = useCurrent(list, texts.length);
  if (texts.length < 2) return null;
  return (
    <nav className="msg-rail" aria-label={t("chat.yourMessages")}>
      {texts.map((text, i) => (
        <button key={i} type="button" className={`msg-rail-mark${i === current ? " is-on" : ""}`} onClick={() => goTo(list, i)} aria-label={text.slice(0, 80)} aria-current={i === current || undefined}>
          <span className="msg-rail-line" aria-hidden />
          <span className="msg-rail-text">{line(text)}</span>
        </button>
      ))}
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
            <button type="button" className={i === current ? "is-on" : undefined} onClick={() => goTo(list, i)} aria-current={i === current || undefined} title={text.slice(0, 300)}>
              {line(text)}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
