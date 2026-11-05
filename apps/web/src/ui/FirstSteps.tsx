import { useApp } from "../context";
import { useAddProject } from "./projects/AddProject";

/**
 * Three first steps for someone new, each with its button and a mark once done (seen: a new user did not know where
 * to start). Gone once all three are done.
 */
export function FirstSteps() {
  const { t, providers, chats, projects, navigate, openNewChat } = useApp();
  const project = useAddProject();
  const done = [providers.length > 0, chats.length > 0, projects.length > 0];
  if (done.every(Boolean)) return null;

  return (
    <section className="first-steps" aria-labelledby="first-steps-h">
      <h2 className="sheet-h" id="first-steps-h">
        {t("start.title")}
      </h2>
      <ol>
        <li className={done[0] ? "is-done" : undefined}>
          <span className="step-mark" aria-hidden>
            {done[0] ? "✓" : "1"}
          </span>
          <div>
            <h3>{t("start.model")}</h3>
            <p className="muted">{t("start.modelHow")}</p>
            <ul className="start-ways">
              <li>
                <strong>{t("start.wayKey")}</strong> {t("start.wayKeyHow")}
              </li>
              <li>
                <strong>{t("start.waySubscription")}</strong> {t("start.waySubscriptionHow")}
              </li>
              <li>
                <strong>{t("start.wayLocal")}</strong> {t("start.wayLocalHow")}
              </li>
            </ul>
            {!done[0] && (
              <div className="actions">
                <button className="btn is-primary" onClick={() => navigate({ kind: "providers" })}>
                  {t("start.connect")}
                </button>
                <button className="btn" onClick={() => navigate({ kind: "local" })}>
                  {t("start.local")}
                </button>
              </div>
            )}
          </div>
        </li>
        <li className={done[1] ? "is-done" : undefined}>
          <span className="step-mark" aria-hidden>
            {done[1] ? "✓" : "2"}
          </span>
          <div>
            <h3>{t("start.chat")}</h3>
            <p className="muted">{t("start.chatHow")}</p>
            {done[0] && !done[1] && (
              <button className="btn is-primary" onClick={openNewChat}>
                {t("home.startChat")}
              </button>
            )}
          </div>
        </li>
        <li className={done[2] ? "is-done" : undefined}>
          <span className="step-mark" aria-hidden>
            {done[2] ? "✓" : "3"}
          </span>
          <div>
            <h3>{t("start.project")}</h3>
            <p className="muted">{t("start.projectHow")}</p>
            {done[0] && !done[2] && window.drimvox?.pickFolder && (
              <button className="btn" onClick={() => void project.pick()}>
                {t("start.pickFolder")}
              </button>
            )}
            {project.failed && <p className="error-note">{t("project.addFailed")}</p>}
          </div>
        </li>
      </ol>
    </section>
  );
}
