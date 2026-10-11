import type { ChatView, ProjectView, ProviderView, Settings, SettingsPatch, TaskView, UsageSummary } from "@artel/shared";
import { createContext, useContext } from "react";
import type { Api } from "./api";
import type { MessageKey } from "./i18n";

export interface CoreStatus {
  version: string;
  dataDir: string;
  schemaVersion: number;
  node: string;
}

/**
 * `key` keeps a chat screen alive while a new chat gets its id, so a streaming answer
 * is not lost when the draft turns into a saved chat.
 */
export type View =
  | { kind: "home" }
  | { kind: "settings" }
  | { kind: "providers" }
  | { kind: "chat"; chatId: string | null; key: string }
  | { kind: "project"; projectId: string }
  | { kind: "task"; taskId: string };

export interface AppContextValue {
  api: Api;
  token: string;
  settings: Settings;
  status: CoreStatus;
  /** Saves a change; resolves to false when the core refused or did not answer. */
  updateSettings(patch: SettingsPatch): Promise<boolean>;
  t(key: MessageKey, vars?: Record<string, string | number>): string;

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
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside <AppContext>");
  return value;
}
