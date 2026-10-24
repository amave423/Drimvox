import { useApp } from "../context";
import type { MessageKey } from "../i18n";
import { FirstSteps } from "./FirstSteps";
import { LinkedText } from "./LinkedText";

/** How to use Drimvox, by what the user meets first (seen: testers asked for hints and instructions). */
const guide: { title: MessageKey; items: MessageKey[] }[] = [
  { title: "home.guide.models", items: ["home.guide.models1", "home.guide.models2", "home.guide.models3"] },
  { title: "home.guide.chat", items: ["home.guide.chat1", "home.guide.chat2", "home.guide.chat3", "home.guide.chat4"] },
  { title: "home.guide.project", items: ["home.guide.project1", "home.guide.project2", "home.guide.project3"] },
  { title: "home.guide.safety", items: ["home.guide.safety1", "home.guide.safety2"] },
];

export function HomeSheet() {
  const { t, status } = useApp();
  return (
    <article className="sheet">
      <div className="sheet-body">
        <h1>{t("home.title")}</h1>
        <p className="lede">{t("home.lede")}</p>
        <FirstSteps />
        <h2 className="sheet-h">{t("home.next")}</h2>
        <div className="guide">
          {guide.map((g) => (
            <section key={g.title} className="guide-part" aria-label={t(g.title)}>
              <h3>{t(g.title)}</h3>
              <ul>
                {g.items.map((key) => (
                  <li key={key}>
                    <LinkedText text={t(key)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
      <aside className="margin">
        <p className="note">{t("home.noteHelp")}</p>
        <p className="note">{t("home.noteCore", { version: status.version, node: status.node })}</p>
        <p className="note">
          {t("home.noteData")}
          <br />
          <span className="mono">{status.dataDir}</span>
        </p>
      </aside>
    </article>
  );
}
