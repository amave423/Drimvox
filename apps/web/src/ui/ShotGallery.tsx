import { createContext, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../context";
import { useAuthorizedUrl } from "../lib/media";
import { dimTitleBar } from "../theme";
import { CrossIcon } from "./SideChats";

/** A screenshot from the core: its address, and what it shows and when, for the caption. */
export interface Shot {
  url: string;
  caption?: string;
}

/** Every screenshot of a conversation, in order: one opened goes on to the others (asked for: a switch between them). */
export const ShotsContext = createContext<Shot[]>([]);
export const useShots = () => useContext(ShotsContext);

/** A screenshot fetched with the token, which an <img> cannot send. */
export function AuthImage({ url, alt, className }: { url: string; alt: string; className?: string }) {
  const { token } = useApp();
  const src = useAuthorizedUrl(url, token);
  return src ? <img className={className} src={src} alt={alt} /> : <span className={`${className ?? ""} is-empty`} aria-hidden />;
}

/** Left, right and the count: the screenshot before, the one after. */
export function useShotIndex(count: number, start: number) {
  const [index, setIndex] = useState(start);
  const at = Math.min(Math.max(index, 0), Math.max(count - 1, 0));
  return { index: at, set: setIndex, prev: () => setIndex(Math.max(at - 1, 0)), next: () => setIndex(Math.min(at + 1, count - 1)) };
}

/**
 * The screenshots over the whole window, one at a time (asked for: many of them were opened and closed one by one):
 * arrows and the arrow keys go between them, the strip below jumps to any, Escape or the cross closes. A whole-page
 * screenshot is shown at its own width and scrolls, so a tall phone page is read, not shrunk to a stripe.
 */
export function ShotGallery({ shots, start, onClose }: { shots: Shot[]; start: number; onClose(): void }) {
  const { t } = useApp();
  const nav = useShotIndex(shots.length, start);
  const shot = shots[nav.index];

  useEffect(() => {
    dimTitleBar(true, "--overlay");
    return () => dimTitleBar(false, "--overlay");
  }, []);
  useEffect(() => {
    // Caught before anything else on the page (seen: Escape did not close the viewer).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") nav.prev();
      else if (e.key === "ArrowRight") nav.next();
      else return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [nav.index, shots.length, onClose]);
  if (!shot) return null;

  return createPortal(
    <div className="shot-gallery" role="dialog" aria-modal="true" aria-label={t("shots.title")} onClick={onClose}>
      <div className="shot-gallery-top" onClick={(e) => e.stopPropagation()}>
        <span className="shot-gallery-count">{t("shots.count", { n: nav.index + 1, total: shots.length })}</span>
        {shot.caption && <span className="shot-gallery-caption mono">{shot.caption}</span>}
        <button type="button" className="shot-gallery-close" aria-label={t("viewer.close")} title={t("viewer.close")} onClick={onClose}>
          <CrossIcon />
        </button>
      </div>
      <div className="shot-gallery-stage" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="shot-gallery-arrow" aria-label={t("shots.prev")} disabled={nav.index === 0} onClick={nav.prev}>
          ‹
        </button>
        <div className="shot-gallery-frame" key={shot.url}>
          <AuthImage url={shot.url} alt={shot.caption ?? t("msg.screenshot")} />
        </div>
        <button type="button" className="shot-gallery-arrow" aria-label={t("shots.next")} disabled={nav.index === shots.length - 1} onClick={nav.next}>
          ›
        </button>
      </div>
      {shots.length > 1 && <ShotStrip shots={shots} index={nav.index} onPick={nav.set} />}
    </div>,
    document.body,
  );
}

/** Small screenshots in a row that scrolls: the current one marked, any one opened by a click. */
export function ShotStrip({ shots, index, onPick }: { shots: Shot[]; index: number; onPick(i: number): void }) {
  const { t } = useApp();
  return (
    <div className="shot-strip" role="tablist" aria-label={t("shots.all")} onClick={(e) => e.stopPropagation()}>
      {shots.map((s, i) => (
        <button
          key={s.url}
          type="button"
          role="tab"
          aria-selected={i === index}
          aria-label={t("shots.count", { n: i + 1, total: shots.length })}
          className={`shot-thumb${i === index ? " is-on" : ""}`}
          // The current one kept in sight by scrolling the strip itself, never the page around it.
          ref={(el) => {
            const strip = el?.parentElement;
            if (!el || !strip || i !== index) return;
            if (el.offsetLeft < strip.scrollLeft || el.offsetLeft + el.offsetWidth > strip.scrollLeft + strip.clientWidth) {
              strip.scrollLeft = el.offsetLeft - strip.clientWidth / 2 + el.offsetWidth / 2;
            }
          }}
          onClick={() => onPick(i)}
        >
          <AuthImage url={s.url} alt="" />
        </button>
      ))}
    </div>
  );
}
