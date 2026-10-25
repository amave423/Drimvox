import { z } from "zod";
import { localVoiceIds } from "./local-speech";

export const themes = ["system", "light", "dark"] as const;
export const locales = ["ru", "en"] as const;
export const currencies = ["RUB", "USD"] as const;

export const settingsSchema = z.object({
  theme: z.enum(themes),
  locale: z.enum(locales),
  /** What prices and spending are shown in. Drimvox stores dollars and converts at the Central Bank rate. */
  currency: z.enum(currencies),
  /** How much one agent task may spend before it stops and asks. */
  agentBudgetUsd: z.number().min(0.01).max(1000),
  /** Model a stuck task escalates to; null means report to the user instead. */
  strongModel: z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) }).nullable(),
  /** The model that looks at screenshots; null means the task's own model, when it sees pictures. */
  visionModel: z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) }).nullable(),
  /** Windows notifications when a task needs the user and the window is not in front. */
  notifications: z.boolean(),
  /** The user writes code: agents also ask about technology; otherwise only about the result, in plain words. */
  developer: z.boolean(),
  /** Model of the acceptance agent; null means the strong model, then the task's own. */
  acceptanceModel: z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) }).nullable(),
  /** Image model agents draw with; null means agents have no picture tool. */
  imageModel: z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) }).nullable(),
  /** The model that turns dictation into text: one that takes audio (Gemini, GPT-4o audio); null: no dictation. */
  voiceModel: z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) }).nullable(),
  /** The Piper voice that reads answers aloud (docs/specs/local-speech.md); null: the system's own voice. */
  speechVoice: z.enum(localVoiceIds).nullable(),
  /** The most the whole app may spend in a calendar month, in dollars; null: no limit. */
  monthlyBudgetUsd: z.number().min(0.00001).max(100000).nullable(),
  /** Models the user starred: the picker's "Favourites" tab, across providers. */
  favoriteModels: z.array(z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) })).max(100),
});

export const settingsPatchSchema = settingsSchema.partial().strict();

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type Theme = Settings["theme"];
export type Locale = Settings["locale"];
export type Currency = Settings["currency"];

export const defaultSettings: Settings = { theme: "system", locale: "ru", currency: "RUB", agentBudgetUsd: 0.5, strongModel: null, imageModel: null, visionModel: null, acceptanceModel: null, notifications: true, developer: false, favoriteModels: [], monthlyBudgetUsd: null, voiceModel: null, speechVoice: null };
