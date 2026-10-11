import type { View } from "../App";
import { useApp } from "../context";

export function Sidebar({ onNavigate }: { onNavigate(view: View): void }) {
  const { t, status } = useApp();
  return (
    <aside className="side">
      <section>
        <h2 className="side-h">{t("side.projects")}</h2>
        <p className="side-empty">{t("side.projectsEmpty")}</p>
      </section>

      <section>
        <h2 className="side-h">{t("side.system")}</h2>
        <ul className="checks">
          <li>
            <i aria-hidden>✓</i>
            {t("side.core")}
          </li>
          <li>
            <i aria-hidden>✓</i>
            {t("side.database", { version: status.schemaVersion })}
          </li>
        </ul>
      </section>

      <nav className="side-nav">
        <span className="side-link is-soon">
          {t("side.keys")}
          <small>{t("side.keysSoon")}</small>
        </span>
        <button className="side-link" onClick={() => onNavigate("settings")}>
          {t("top.settings")}
        </button>
      </nav>
    </aside>
  );
}
