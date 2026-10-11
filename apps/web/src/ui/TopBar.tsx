import type { View } from "../App";
import { useApp } from "../context";

export function TopBar({ view, onNavigate }: { view: View; onNavigate(view: View): void }) {
  const { t } = useApp();
  return (
    <header className="topbar">
      <button className="logo" onClick={() => onNavigate("home")} title={t("top.home")}>
        Artel
      </button>
      <span className="crumb">{t("top.noProject")}</span>
      <span className="spacer" />
      <button
        className={`topbar-link${view === "settings" ? " is-on" : ""}`}
        onClick={() => onNavigate(view === "settings" ? "home" : "settings")}
        aria-pressed={view === "settings"}
      >
        {t("top.settings")}
      </button>
    </header>
  );
}
