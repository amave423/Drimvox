import { z } from "zod";

export const themes = ["system", "light", "dark"] as const;
export const locales = ["ru", "en"] as const;

export const settingsSchema = z.object({
  theme: z.enum(themes),
  locale: z.enum(locales),
});

export const settingsPatchSchema = settingsSchema.partial().strict();

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type Theme = Settings["theme"];
export type Locale = Settings["locale"];

export const defaultSettings: Settings = { theme: "system", locale: "ru" };
