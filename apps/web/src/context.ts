import type { ChatView, ProjectView, ProviderView, Settings, SettingsPatch, TaskView, UsageSummary, ProjectWorkView } from "@drimvox/shared";
import { createContext, useContext } from "react";
import type { Api } from "./api";
import type { MessageKey } from "./i18n";

export interface CoreStatus {
  version: string;
  dataDir: string;
  schemaVersion: number;
  node: string;
  platform: string;
}

/**
 * `key` keeps a chat screen alive while a new chat gets its id, so a streaming answer
 * is not lost when the draft turns into a saved chat.
 */
export type LocalPart = "text" | "image" | "video" | "audio";

export type View =
  | { kind: "home" }
  | { kind: "settings" }
  | { kind: "providers" }
  /** `part`: which of the local models to show first (text through Ollama, pictures, video). */
  | { kind: "local"; part?: LocalPart }
  | { kind: "gallery" }
  /** How to use Drimvox, apart from the start page. */
  | { kind: "guide" }
  /** `send`: a message to send at once, the first of a project task's conversation. */
  | { kind: "chat"; chatId: string | null; key: string; send?: string }
  | { kind: "project"; projectId: string }
  /** The projects' mode with no project open yet. */
  | { kind: "projects" }
  | { kind: "task"; taskId: string };

export interface AppContextValue {
  api: Api;
  token: string | null;
  settings: Settings;
  status: CoreStatus;
  /** Saves a change; resolves to false when the core refused or did not answer. */
  updateSettings(patch: SettingsPatch): Promise<boolean>;
  t(key: MessageKey, vars?: Record<string, string | number>): string;

  /** Rubles per dollar from the core; 0 until known. */
  usdRub: number;
  view: View;
  navigate(view: View): void;
  openNewChat(): void;

  providers: ProviderView[];
  reloadProviders(): Promise<void>;
  chats: ChatView[];
  reloadChats(): Promise<void>;
  today: UsageSummary | null;
  reloadToday(): Promise<void>;
  projects: ProjectView[];
  reloadProjects(): Promise<void>;
  tasks: TaskView[];
  reloadTasks(): Promise<void>;
  /** Every project's work, kept fresh: the projects' list shows how each goes. */
  works: ProjectWorkView[];
  reloadWorks(): void;
}

/**
 * The projects' mode (asked for: a mode of its own, switched like Claude Code's): a project's workshop, the projects'
 * start, a project's task and a task's conversation.
 */
export const inProjects = (view: View, chats: ChatView[] = []) =>
  view.kind === "project" || view.kind === "projects" || view.kind === "task" || (view.kind === "chat" && !!chats.find((c) => c.id === view.chatId)?.projectId);

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside <AppContext>");
  return value;
}
