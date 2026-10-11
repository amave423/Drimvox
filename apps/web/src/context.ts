import type { Settings, SettingsPatch } from "@artel/shared";
import { createContext, useContext } from "react";
import type { Api } from "./api";
import type { MessageKey } from "./i18n";

export interface CoreStatus {
  version: string;
  dataDir: string;
  schemaVersion: number;
  node: string;
}

export interface AppContextValue {
  api: Api;
  settings: Settings;
  status: CoreStatus;
  /** Saves a change; resolves to false when the core refused or did not answer. */
  updateSettings(patch: SettingsPatch): Promise<boolean>;
  t(key: MessageKey, vars?: Record<string, string | number>): string;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside <AppContext>");
  return value;
}
