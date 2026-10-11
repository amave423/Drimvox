import { useApp } from "../context";

const milestones = ["home.m2", "home.m3", "home.m4"] as const;

export function HomeSheet() {
  const { t, status, providers, navigate, openNewChat } = useApp();
  return (
    <article className="sheet">
      <div className="sheet-body">
        <h1>{t("home.title")}</h1>
        <p className="lede">{t("home.lede")}</p>
        <div className="actions">
          {providers.length === 0 ? (
            <button className="btn is-primary" onClick={() => navigate({ kind: "providers" })}>
              {t("home.connect")}
            </button>
          ) : (
            <button className="btn is-primary" onClick={openNewChat}>
              {t("home.startChat")}
            </button>
          )}
        </div>
        <h2 className="sheet-h">{t("home.next")}</h2>
        <ol className="steps">
          {milestones.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ol>
      </div>
      <aside className="margin">
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
