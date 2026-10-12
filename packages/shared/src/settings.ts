import { z } from "zod";

export const themes = ["system", "light", "dark"] as const;
export const locales = ["ru", "en"] as const;

export const settingsSchema = z.object({
  theme: z.enum(themes),
  locale: z.enum(locales),
  /** How much one agent task may spend before it stops and asks. */
  agentBudgetUsd: z.number().min(0.01).max(1000),
  /** Model a stuck task escalates to; null means report to the user instead. */
  strongModel: z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) }).nullable(),
});

export const settingsPatchSchema = settingsSchema.partial().strict();

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type Theme = Settings["theme"];
export type Locale = Settings["locale"];

export const defaultSettings: Settings = { theme: "system", locale: "ru", agentBudgetUsd: 0.5, strongModel: null };
