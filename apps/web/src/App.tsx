import type { Settings, SettingsPatch } from "@artel/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ok, type Api } from "./api";
import { AppContext, type AppContextValue, type CoreStatus } from "./context";
import { translate } from "./i18n";
import { applyTheme, resolveTheme } from "./theme";
import { HomeSheet } from "./ui/HomeSheet";
import { SettingsSheet } from "./ui/SettingsSheet";
import { Sidebar } from "./ui/Sidebar";
import { TopBar } from "./ui/TopBar";

export type View = "home" | "settings";

interface Props {
  api: Api;
  initialSettings: Settings;
  status: CoreStatus;
}

export function App({ api, initialSettings, status }: Props) {
  const [settings, setSettings] = useState(initialSettings);
  const [view, setView] = useState<View>("home");
  const systemDark = useSystemDark();

  useEffect(() => applyTheme(resolveTheme(settings.theme, systemDark)), [settings.theme, systemDark]);
  useEffect(() => {
    document.documentElement.lang = settings.locale;
  }, [settings.locale]);

  const updateSettings = useCallback(
    async (patch: SettingsPatch) => {
      try {
        setSettings(await ok<Settings>(await api.settings.$patch({ json: patch })));
        return true;
      } catch {
        return false;
      }
    },
    [api],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      api,
      settings,
      status,
      updateSettings,
      t: (key, vars) => translate(settings.locale, key, vars),
    }),
    [api, settings, status, updateSettings],
  );

  return (
    <AppContext.Provider value={value}>
      <div className="shell">
        <TopBar view={view} onNavigate={setView} />
        <Sidebar onNavigate={setView} />
        <main className="desk">{view === "home" ? <HomeSheet /> : <SettingsSheet />}</main>
        <footer className="bottombar">
          <span>{value.t("bottom.version", { version: status.version })}</span>
        </footer>
      </div>
    </AppContext.Provider>
  );
}

function useSystemDark(): boolean {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}
