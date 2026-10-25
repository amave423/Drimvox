import { useState } from "react";
import { useApp } from "../context";
import type { MessageKey } from "../i18n";
import { readLastModel, rememberLastModel, type ModelChoice } from "../lib/lastModel";
import { ModelPicker } from "./chat/ModelPicker";
import { FirstSteps } from "./FirstSteps";
import { LinkedText } from "./LinkedText";

/** How to use Drimvox, by what the user meets first (seen: testers asked for hints and instructions). */
const guide: { title: MessageKey; items: MessageKey[] }[] = [
  { title: "home.guide.models", items: ["home.guide.models1", "home.guide.models2", "home.guide.models3"] },
  { title: "home.guide.chat", items: ["home.guide.chat1", "home.guide.chat2", "home.guide.chat3", "home.guide.chat4"] },
  { title: "home.guide.project", items: ["home.guide.project1", "home.guide.project2", "home.guide.project3"] },
  { title: "home.guide.safety", items: ["home.guide.safety1", "home.guide.safety2"] },
];

const RECENT = 5;

/**
 * The start: a question to a model right here, the chats from last time, the first steps while some are left, and the
 * guide folded away once a model is connected (seen: the page was a manual with no way to just ask something).
 */
export function HomeSheet() {
  const { t, providers, chats, navigate, settings } = useApp();
  const ready = providers.length > 0;
  const recent = chats.filter((c) => !c.projectId).slice(0, RECENT);
  return (
    <article className="sheet">
      <div className="sheet-body home">
        <h1>{t("home.title")}</h1>
        <p className="lede">{t("home.lede")}</p>
        {ready && <HomeAsk />}
        <FirstSteps />
        {recent.length > 0 && (
          <section aria-labelledby="home-recent-h">
            <h2 className="sheet-h" id="home-recent-h">
              {t("home.recent")}
            </h2>
            <ul className="home-recent">
              {recent.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => navigate({ kind: "chat", chatId: c.id, key: c.id })}>
                    <span className="home-recent-title">{c.title ?? t("chat.untitled")}</span>
                    <span className="muted">{new Date(c.updatedAt).toLocaleDateString(settings.locale === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "short" })}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <details className="home-guide" open={!ready}>
          <summary className="sheet-h">{t("home.next")}</summary>
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
        </details>
      </div>
      <aside className="margin">
        <p className="note">{t("home.noteHelp")}</p>
      </aside>
    </article>
  );
}

/** A question for a model from the start page: sending it opens a new chat that asks it at once. */
function HomeAsk() {
  const { t, providers, navigate } = useApp();
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<ModelChoice | null>(() => {
    const last = readLastModel();
    return last && providers.some((p) => p.id === last.providerId) ? last : null;
  });
  const can = !!choice && !!text.trim();
  const ask = () => {
    if (!can) return;
    rememberLastModel(choice);
    navigate({ kind: "chat", chatId: null, key: `draft-${Date.now()}`, send: text.trim() });
  };
  return (
    <form
      className="home-ask"
      onSubmit={(e) => {
        e.preventDefault();
        ask();
      }}
    >
      <textarea
        className="field-input"
        rows={3}
        value={text}
        placeholder={t("home.askPlaceholder")}
        aria-label={t("home.ask")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            ask();
          }
        }}
      />
      <div className="home-ask-bar">
        <ModelPicker value={choice} onChange={setChoice} kinds={["text", "image", "video"]} />
        <button className="btn is-primary" disabled={!can}>
          {t("home.askSend")}
        </button>
      </div>
    </form>
  );
}
