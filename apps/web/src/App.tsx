import type { MonthUsage, ChatView, ProjectView, ProjectWorkView, ProviderView, Settings, SettingsPatch, TaskView, UsageSummary } from "@drimvox/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ok, type Api } from "./api";
import { AppContext, type AppContextValue, type CoreStatus, type View } from "./context";
import { translate } from "./i18n";
import { formatUsd, setDisplayCurrency, startOfToday } from "./lib/format";
import { noticesFor } from "./lib/notices";
import { workNotices } from "./lib/workNotices";
import { applyTheme, resolveTheme } from "./theme";
import { ChatSheet } from "./ui/chat/ChatSheet";
import { HomeSheet } from "./ui/HomeSheet";
import { ProjectSheet } from "./ui/projects/ProjectSheet";
import { ProvidersSheet } from "./ui/providers/ProvidersSheet";
import { LocalModelsSheet } from "./ui/local/LocalModelsSheet";
import { TaskSheet } from "./ui/tasks/TaskSheet";
import { GallerySheet } from "./ui/GallerySheet";
import { GuideSheet } from "./ui/GuideSheet";
import { SettingsSheet } from "./ui/SettingsSheet";
import { preloadModels } from "./lib/models";
import { DownloadNote } from "./ui/DownloadNote";
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
  const [month, setMonth] = useState<MonthUsage | null>(null);
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
  // Every provider's model list is asked for once it is known, so the picker opens with it at once.
  useEffect(() => preloadModels(api, providers), [api, providers]);
  const reloadChats = useCallback(async () => {
    setChats(await api.chats.$get().then((r) => ok<ChatView[]>(r)).catch(() => []));
  }, [api]);
  const reloadToday = useCallback(async () => {
    const since = String(startOfToday());
    setToday(await api.usage.$get({ query: { since } }).then((r) => ok<UsageSummary>(r)).catch(() => null));
    setMonth(await api.usage.month.$get().then((r) => ok<MonthUsage>(r)).catch(() => null));
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
      if (window.drimvox?.notify) window.drimvox.notify({ title, body: n.title, taskId: n.taskId });
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
  useEffect(() => window.drimvox?.onOpenTask?.((taskId) => setView({ kind: "task", taskId })), []);

  // A project's run that waits for a permission, is done or stopped becomes a notification too (docs/specs/project-work.md):
  // seen live, a run waited half an hour on a permission nobody saw.
  const seenWork = useRef<ProjectWorkView[] | null>(null);
  const [works, setWorks] = useState<ProjectWorkView[]>([]);
  const working = works.some((w) => w.status === "running" || w.status === "planning");
  useEffect(() => {
    const look = async () => {
      const next = await api.work.$get().then((r) => ok<ProjectWorkView[]>(r)).catch(() => null);
      if (!next) return;
      const notices = workNotices(seenWork.current, next);
      seenWork.current = next;
      setWorks(next);
      if (!settings.notifications) return;
      for (const n of notices) {
        const title = translate(settings.locale, `notice.work.${n.kind}`);
        const body = projects.find((p) => p.id === n.projectId)?.name ?? "";
        if (window.drimvox?.notify) window.drimvox.notify({ title, body, taskId: n.taskId ?? "" });
        else if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) new Notification(title, { body, tag: n.projectId });
      }
    };
    void look();
    const timer = setInterval(() => void look(), working ? 3000 : 15000);
    return () => clearInterval(timer);
  }, [api, working, settings.notifications, settings.locale, projects]);

  useEffect(() => {
    void reloadProviders();
    void reloadChats();
    void reloadToday();
    void reloadProjects();
    void reloadTasks();
  }, [reloadProviders, reloadChats, reloadToday, reloadProjects, reloadTasks]);

  // A chat whose model answers shows a spinner in the list, then a dot when the answer is ready: kept fresh meanwhile.
  const answering = chats.some((c) => c.answering);
  useEffect(() => {
    if (!answering) return;
    const timer = setInterval(() => void reloadChats(), 1500);
    return () => clearInterval(timer);
  }, [answering, reloadChats]);

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
          {view.kind === "guide" && <GuideSheet />}
          {view.kind === "chat" && <ChatSheet key={view.key} chatId={view.chatId} viewKey={view.key} autoSend={view.send} />}
          {view.kind === "project" && <ProjectSheet key={view.projectId} projectId={view.projectId} />}
          {view.kind === "task" && <TaskSheet key={view.taskId} taskId={view.taskId} />}
        </main>
        <footer className="bottombar">
          {today && <span>{value.t("bottom.today", { cost: formatUsd(today.costUsd) })}</span>}
          {/* The month against its budget, once there is one: amber near it, red past it. */}
          {month?.budgetUsd != null && (
            <span className={`bottom-month${month.over ? " is-over" : month.spentUsd >= month.budgetUsd * 0.8 ? " is-near" : ""}`}>
              {value.t("bottom.month", { spent: formatUsd(month.spentUsd), budget: formatUsd(month.budgetUsd) })}
            </span>
          )}
          <span className="spacer" />
          <DownloadNote />
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
