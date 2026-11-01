import { z } from "zod";
import { localVoiceIds } from "./local-speech";

export const themes = ["system", "light", "dark"] as const;
export const locales = ["ru", "en"] as const;
export const currencies = ["RUB", "USD"] as const;
/** The notification sounds, made by Drimvox itself from tones (apps/web/src/lib/sounds.ts): no recordings, no licences. */
/** What the browser's address field searches with; "auto": Yandex in Russian, Bing in English (as it was). */
export const searchEngines = ["auto", "google", "yandex", "duckduckgo", "bing"] as const;
export type SearchEngine = (typeof searchEngines)[number];
/** Agents that do not read AGENTS.md by default, each with the file it reads: a one-line pointer there (asked for). */
export const agentFiles = ["claude", "gemini", "qwen"] as const;
export type AgentFile = (typeof agentFiles)[number];
export const agentFileNames: Record<AgentFile, string> = { claude: "CLAUDE.md", gemini: "GEMINI.md", qwen: "QWEN.md" };
export const noticeSounds = ["drop", "chime", "soft", "pop", "off"] as const;

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
  /** The sound of Drimvox's own notifications; "off": silent. */
  notifySound: z.enum(noticeSounds),
  /** Its loudness, 0 to 1. */
  notifyVolume: z.number().min(0).max(1),
  /** The user writes code: agents also ask about technology; otherwise only about the result, in plain words. */
  developer: z.boolean(),
  /** Model of the acceptance agent; null means the strong model, then the task's own. */
  acceptanceModel: z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) }).nullable(),
  /** Image model agents draw with; null means agents have no picture tool. */
  imageModel: z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) }).nullable(),
  /** The model that turns dictation into text: one that takes audio (Gemini, GPT-4o audio); null: no dictation. */
  voiceModel: z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) }).nullable(),
  /**
   * The language dictation is spoken in: the interface's by default (seen: whisper guessed short Russian phrases wrong
   * until told the language), guessed by the model, or fixed.
   */
  dictationLanguage: z.enum(["interface", "auto", "ru", "en"]),
  /** The Piper voice that reads answers aloud (docs/specs/local-speech.md); null: the system's own voice. */
  speechVoice: z.enum(localVoiceIds).nullable(),
  /** A provider's voice that reads answers instead (asked for: voices from the cloud); null: the Piper or system voice. */
  cloudVoice: z.object({ providerId: z.string().min(1), voice: z.string().min(1).max(60) }).nullable(),
  /** The most the whole app may spend in a calendar month, in dollars; null: no limit. */
  monthlyBudgetUsd: z.number().min(0.00001).max(100000).nullable(),
  /** A chat with a connected folder runs its commands without asking (asked for: a switch, auto or by hand). */
  folderAutoApprove: z.boolean(),
  /** Models the user starred: the picker's "Favourites" tab, across providers. */
  /** The browser's address field searches with it (asked for: a choice instead of Yandex alone). */
  searchEngine: z.enum(searchEngines),
  /** Pointer files to AGENTS.md for agents that read their own file (Claude Code, Gemini CLI, Qwen Code); none by default. */
  agentFiles: z.array(z.enum(agentFiles)).max(3),
  favoriteModels: z.array(z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) })).max(100),
});

export const settingsPatchSchema = settingsSchema.partial().strict();

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type Theme = Settings["theme"];
export type Locale = Settings["locale"];
export type Currency = Settings["currency"];

export const defaultSettings: Settings = { theme: "system", locale: "ru", currency: "RUB", agentBudgetUsd: 0.5, strongModel: null, imageModel: null, visionModel: null, acceptanceModel: null, notifications: true, notifySound: "drop", notifyVolume: 0.6, developer: false, folderAutoApprove: false, favoriteModels: [], searchEngine: "auto", agentFiles: [], monthlyBudgetUsd: null, voiceModel: null, dictationLanguage: "interface", speechVoice: null, cloudVoice: null };

/**
 * Voices of the providers that read answers aloud (docs/specs/local-speech.md): Gemini's speech models and OpenAI's.
 * Each speaks Russian and English; `kind` is how it sounds, for the list.
 */
export const cloudVoices: Record<"google" | "openai", { id: string; kind: "female" | "male" }[]> = {
  google: [
    { id: "Kore", kind: "female" },
    { id: "Aoede", kind: "female" },
    { id: "Leda", kind: "female" },
    { id: "Zephyr", kind: "female" },
    { id: "Charon", kind: "male" },
    { id: "Puck", kind: "male" },
    { id: "Orus", kind: "male" },
    { id: "Fenrir", kind: "male" },
  ],
  openai: [
    { id: "nova", kind: "female" },
    { id: "shimmer", kind: "female" },
    { id: "coral", kind: "female" },
    { id: "sage", kind: "female" },
    { id: "alloy", kind: "male" },
    { id: "ash", kind: "male" },
    { id: "echo", kind: "male" },
    { id: "onyx", kind: "male" },
  ],
};
