import { useState } from "react";
import { useApp } from "../context";
import { readLastModel, rememberLastModel, type ModelChoice } from "../lib/lastModel";
import { ModelPicker } from "./chat/ModelPicker";
import { useAddProject } from "./projects/AddProject";

/**
 * The start page, as in the chat apps (asked for): a greeting and a box to ask in, in the middle of the sheet, and a
 * few ways onward under it. The explanations live on the instructions' page. Someone with no model yet is shown how
 * to connect one instead of the box.
 */
export function HomeSheet() {
  const { t, providers, navigate } = useApp();
  const project = useAddProject();
  const ready = providers.length > 0;
  return (
    <article className="sheet home-start">
      <div className="sheet-body home-center">
        {ready ? (
          <>
            <h1 className="home-greet">{t("home.greet")}</h1>
            <HomeAsk />
            <div className="home-chips">
              {window.drimvox?.pickFolder && (
                <button type="button" className="chip" onClick={() => void project.pick()}>
                  {t("home.chipProject")}
                </button>
              )}
              <button type="button" className="chip" onClick={() => navigate({ kind: "gallery" })}>
                {t("home.chipGallery")}
              </button>
              <button type="button" className="chip" onClick={() => navigate({ kind: "guide" })}>
                {t("home.chipGuide")}
              </button>
            </div>
            {project.failed && <p className="error-note">{t("project.addFailed")}</p>}
          </>
        ) : (
          <>
            <h1 className="home-greet">{t("home.title")}</h1>
            <p className="home-lede">{t("home.startLede")}</p>
            <div className="actions home-actions">
              <button className="btn is-primary" onClick={() => navigate({ kind: "providers" })}>
                {t("start.connect")}
              </button>
              <button className="btn" onClick={() => navigate({ kind: "local" })}>
                {t("start.local")}
              </button>
            </div>
            <button type="button" className="link" onClick={() => navigate({ kind: "guide" })}>
              {t("home.chipGuide")}
            </button>
          </>
        )}
      </div>
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
        className="home-ask-input"
        rows={3}
        value={text}
        autoFocus
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
