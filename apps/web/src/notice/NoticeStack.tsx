import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { translate } from "../i18n";
import { playSound } from "../lib/sounds";
import { Logo } from "../ui/Logo";

/** How long a notification stays when nobody points at it. */
const STAY_MS = 7000;
/** More than this many at once: the oldest goes. */
const MOST = 3;

/**
 * Drimvox's own notifications (asked for: like Telegram's, with its own sound), in a small window of their own at the
 * bottom right of the screen (apps/desktop/src/notices.ts): the mark in the mode's colours, the title, the text, a
 * click opens what it is about, and it goes by itself unless pointed at.
 */
export function NoticeStack({ bridge }: { bridge: NoticeBridge }) {
  const [list, setList] = useState<(DrimvoxNotice & { leaving?: boolean })[]>([]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      bridge.onNotice((notice) => {
        const root = document.documentElement;
        root.dataset.theme = notice.dark ? "dark" : "light";
        root.dataset.mode = notice.mode;
        root.lang = notice.locale;
        playSound(notice.sound, notice.volume);
        setList((now) => [...now, notice].slice(-MOST));
      }),
    [bridge],
  );

  // The window is as tall as the cards in it, and hides when there are none.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const report = () => bridge.size(list.length ? Math.ceil(el.getBoundingClientRect().height) : 0);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bridge, list.length]);

  const leave = (id: string) => {
    setList((now) => now.map((n) => (n.id === id ? { ...n, leaving: true } : n)));
    setTimeout(() => setList((now) => now.filter((n) => n.id !== id)), 220);
  };

  return (
    <div className="notice-stack" ref={box}>
      {list.map((n) => (
        <NoticeCard
          key={n.id}
          notice={n}
          leaving={!!n.leaving}
          onOpen={() => {
            bridge.open(n.id);
            leave(n.id);
          }}
          onClose={() => leave(n.id)}
        />
      ))}
    </div>
  );
}

function NoticeCard({ notice, leaving, onOpen, onClose }: { notice: DrimvoxNotice; leaving: boolean; onOpen(): void; onClose(): void }) {
  const [pointed, setPointed] = useState(false);
  // It goes by itself, but not while the pointer is on it: there is time to read.
  useEffect(() => {
    if (pointed || leaving) return;
    const timer = setTimeout(onClose, STAY_MS);
    return () => clearTimeout(timer);
  }, [pointed, leaving]);
  const t = (key: "notice.close" | "notice.now") => translate(notice.locale, key);
  return (
    <div className={`notice-card${leaving ? " is-leaving" : ""}`} onPointerEnter={() => setPointed(true)} onPointerLeave={() => setPointed(false)}>
      <button type="button" className="notice-main" onClick={onOpen}>
        <span className="notice-mark" aria-hidden>
          <Logo size={26} />
        </span>
        <span className="notice-text">
          <span className="notice-head">
            <strong className="notice-title">{notice.title}</strong>
            <span className="notice-when">{t("notice.now")}</span>
          </span>
          <span className="notice-body">{notice.body}</span>
        </span>
      </button>
      <button type="button" className="notice-close" aria-label={t("notice.close")} onClick={onClose}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
