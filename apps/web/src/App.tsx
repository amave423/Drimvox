import type { ChatView, ProjectView, ProviderView, Settings, SettingsPatch, TaskView, UsageSummary } from "@artel/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ok, type Api } from "./api";
import { AppContext, type AppContextValue, type CoreStatus, type View } from "./context";
import { translate } from "./i18n";
import { formatUsd, startOfToday } from "./lib/format";
import { applyTheme, resolveTheme } from "./theme";
import { ChatSheet } from "./ui/chat/ChatSheet";
import { HomeSheet } from "./ui/HomeSheet";
import { ProjectSheet } from "./ui/projects/ProjectSheet";
import { ProvidersSheet } from "./ui/providers/ProvidersSheet";
import { TaskSheet } from "./ui/tasks/TaskSheet";
import { SettingsSheet } from "./ui/SettingsSheet";
import { Sidebar } from "./ui/Sidebar";
import { TopBar } from "./ui/TopBar";

interface Props {
  api: Api;
  token: string;
  initialSettings: Settings;
  status: CoreStatus;
}

export function App({ api, token, initialSettings, status }: Props) {
  const [settings, setSettings] = useState(initialSettings);
  const [view, setView] = useState<View>({ kind: "home" });
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [chats, setChats] = useState<ChatView[]>([]);
  const [today, setToday] = useState<UsageSummary | null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
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

  const reloadProviders = useCallback(async () => {
    setProviders(await api.providers.$get().then((r) => ok<ProviderView[]>(r)).catch(() => []));
  }, [api]);
  const reloadChats = useCallback(async () => {
    setChats(await api.chats.$get().then((r) => ok<ChatView[]>(r)).catch(() => []));
  }, [api]);
  const reloadToday = useCallback(async () => {
    const since = String(startOfToday());
    setToday(await api.usage.$get({ query: { since } }).then((r) => ok<UsageSummary>(r)).catch(() => null));
  }, [api]);

  const reloadProjects = useCallback(async () => {
    setProjects(await api.projects.$get().then((r) => ok<ProjectView[]>(r)).catch(() => []));
  }, [api]);
  const reloadTasks = useCallback(async () => {
    setTasks(await api.tasks.$get().then((r) => ok<TaskView[]>(r)).catch(() => []));
  }, [api]);

  useEffect(() => {
    void reloadProviders();
    void reloadChats();
    void reloadToday();
    void reloadProjects();
    void reloadTasks();
  }, [reloadProviders, reloadChats, reloadToday, reloadProjects, reloadTasks]);

  // Keep the sidebar's task statuses fresh while an agent is busy.
  const busy = tasks.some((t) => t.status === "running" || t.status === "waiting");
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      void reloadTasks();
      void reloadToday();
    }, 2000);
    return () => clearInterval(timer);
  }, [busy, reloadTasks, reloadToday]);

  const value = useMemo<AppContextValue>(
    () => ({
      api,
      token,
      settings,
      status,
      updateSettings,
      t: (key, vars) => translate(settings.locale, key, vars),
      view,
      navigate: setView,
      openNewChat: () => setView({ kind: "chat", chatId: null, key: `draft-${Date.now()}` }),
      providers,
      reloadProviders,
      chats,
      reloadChats,
      today,
      reloadToday,
      projects,
      reloadProjects,
      tasks,
      reloadTasks,
    }),
    [
      api,
      token,
      settings,
      status,
      updateSettings,
      view,
      providers,
      reloadProviders,
      chats,
      reloadChats,
      today,
      reloadToday,
      projects,
      reloadProjects,
      tasks,
      reloadTasks,
    ],
  );

  return (
    <AppContext.Provider value={value}>
      <div className="shell">
        <TopBar />
        <Sidebar />
        <main className="desk">
          {view.kind === "home" && <HomeSheet />}
          {view.kind === "settings" && <SettingsSheet />}
          {view.kind === "providers" && <ProvidersSheet />}
          {view.kind === "chat" && <ChatSheet key={view.key} chatId={view.chatId} viewKey={view.key} />}
          {view.kind === "project" && <ProjectSheet key={view.projectId} projectId={view.projectId} />}
          {view.kind === "task" && <TaskSheet key={view.taskId} taskId={view.taskId} />}
        </main>
        <footer className="bottombar">
          {today && <span>{value.t("bottom.today", { cost: formatUsd(today.costUsd) })}</span>}
          <span className="spacer" />
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
