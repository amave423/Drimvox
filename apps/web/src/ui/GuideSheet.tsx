import { useApp } from "../context";
import type { MessageKey } from "../i18n";
import { FirstSteps } from "./FirstSteps";
import { LinkedText } from "./LinkedText";

/** A part of the guide: its title, a line about it, its points; `steps`: points to be done in order. */
interface Part {
  id: string;
  points: number;
  lede?: boolean;
  steps?: boolean;
}

/**
 * The guide, from what the user meets first to the questions people ask (asked for: newcomers understood nothing from
 * the short version). Its texts are guide.<id>.title, .lede and .1…n.
 */
const PARTS: Part[] = [
  { id: "about", points: 3 },
  { id: "connect", points: 4, lede: true },
  { id: "modes", points: 3 },
  { id: "chat", points: 5, lede: true },
  { id: "project", points: 8, lede: true, steps: true },
  { id: "money", points: 4 },
  { id: "extras", points: 3 },
  { id: "faq", points: 5 },
];

const key = (id: string, what: string) => `guide.${id}.${what}` as MessageKey;

/** The instructions on a page of their own: the first steps while some are left, the contents, then part by part. */
export function GuideSheet() {
  const { t } = useApp();
  const go = (id: string) => document.getElementById(`guide-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <article className="sheet guide-sheet">
      <div className="sheet-body">
        <h1>{t("guide.title")}</h1>
        <p className="lede">{t("guide.lede")}</p>
        <FirstSteps />
        <nav className="guide-contents" aria-label={t("guide.contents")}>
          {PARTS.map((p) => (
            <button key={p.id} type="button" className="chip" onClick={() => go(p.id)}>
              {t(key(p.id, "title"))}
            </button>
          ))}
        </nav>
        {PARTS.map((p) => {
          const List = p.steps ? "ol" : "ul";
          return (
            <section key={p.id} id={`guide-${p.id}`} className="guide-part" aria-label={t(key(p.id, "title"))}>
              <h2 className="sheet-h">{t(key(p.id, "title"))}</h2>
              {p.lede && <p className="muted">{t(key(p.id, "lede"))}</p>}
              <List className={p.steps ? "guide-steps" : undefined}>
                {Array.from({ length: p.points }, (_, i) => (
                  <li key={i}>
                    <LinkedText text={t(key(p.id, String(i + 1)))} />
                  </li>
                ))}
              </List>
            </section>
          );
        })}
      </div>
    </article>
  );
}
