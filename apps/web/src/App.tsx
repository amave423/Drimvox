import type { ChatView, ProjectView, ProviderView, Settings, SettingsPatch, TaskView, UsageSummary } from "@artel/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ok, type Api } from "./api";
import { AppContext, type AppContextValue, type CoreStatus, type View } from "./context";
import { translate } from "./i18n";
import { formatUsd, setDisplayCurrency, startOfToday } from "./lib/format";
import { noticesFor } from "./lib/notices";
import { applyTheme, resolveTheme } from "./theme";
import { ChatSheet } from "./ui/chat/ChatSheet";
import { HomeSheet } from "./ui/HomeSheet";
import { ProjectSheet } from "./ui/projects/ProjectSheet";
import { ProvidersSheet } from "./ui/providers/ProvidersSheet";
import { LocalModelsSheet } from "./ui/local/LocalModelsSheet";
import { TaskSheet } from "./ui/tasks/TaskSheet";
import { GallerySheet } from "./ui/GallerySheet";
import { SettingsSheet } from "./ui/SettingsSheet";
import { UpdateNote } from "./ui/UpdateNote";
import { Sidebar } from "./ui/Sidebar";
import { TopBar } from "./ui/TopBar";

interface Props {
  api: Api;
  /** Null in a browser on the server, signed in by its cookie. */
  token: string | null;
  initialSettings: Settings;
  status: CoreStatus;
}

export function App({ api, token, initialSettings, status }: Props) {
  const [settings, setSettings] = useState(initialSettings);
  // The desktop opens on the local models when the installer was asked to install Ollama (apps/desktop/src/main.ts).
  const [view, setView] = useState<View>(() =>
    location.hash === "#local" ? { kind: "local" } : location.hash === "#local-images" ? { kind: "local", part: "image" } : { kind: "home" },
  );
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [chats, setChats] = useState<ChatView[]>([]);
  const [today, setToday] = useState<UsageSummary | null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [usdRub, setUsdRub] = useState(0);
  const systemDark = useSystemDark();

  useEffect(() => {
    void api.rates
      .$get()
      .then((r) => ok<{ usdRub: number }>(r))
      .then((r) => setUsdRub(r.usdRub))
      .catch(() => null);
  }, [api]);
  // Every amount on screen goes through the formatters, which read this before the tree renders.
  setDisplayCurrency(usdRub > 0 ? settings.currency : "USD", usdRub);

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
  const tasksLoaded = useRef(false);
  const reloadTasks = useCallback(async () => {
    const next = await api.tasks.$get().then((r) => ok<TaskView[]>(r)).catch(() => null);
    if (!next) return;
    tasksLoaded.current = true;
    setTasks(next);
  }, [api]);

  // A task that now needs the user becomes a Windows notification (shown only while the window is elsewhere).
  const seenTasks = useRef<TaskView[] | null>(null);
  useEffect(() => {
    if (!tasksLoaded.current) return;
    const notices = noticesFor(seenTasks.current, tasks);
    seenTasks.current = tasks;
    if (!settings.notifications) return;
    for (const n of notices) {
      const title = translate(settings.locale, `notice.${n.kind}`);
      if (window.artel?.notify) window.artel.notify({ title, body: n.title, taskId: n.taskId });
      // In a browser: the browser's own notifications, once allowed, while the tab is in the background.
      else if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
        const shown = new Notification(title, { body: n.title, tag: n.taskId });
        shown.onclick = () => {
          window.focus();
          setView({ kind: "task", taskId: n.taskId });
          shown.close();
        };
      }
    }
  }, [tasks]);
  useEffect(() => window.artel?.onOpenTask?.((taskId) => setView({ kind: "task", taskId })), []);

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
      usdRub,
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
      usdRub,
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
          {view.kind === "local" && <LocalModelsSheet part={view.part} />}
          {view.kind === "gallery" && <GallerySheet />}
          {view.kind === "chat" && <ChatSheet key={view.key} chatId={view.chatId} viewKey={view.key} autoSend={view.send} />}
          {view.kind === "project" && <ProjectSheet key={view.projectId} projectId={view.projectId} />}
          {view.kind === "task" && <TaskSheet key={view.taskId} taskId={view.taskId} />}
        </main>
        <footer className="bottombar">
          {today && <span>{value.t("bottom.today", { cost: formatUsd(today.costUsd) })}</span>}
          <span className="spacer" />
          <UpdateNote />
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
