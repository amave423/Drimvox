import { z } from "zod";
import { localVoiceIds } from "./local-speech";

export const themes = ["system", "light", "dark"] as const;
export const locales = ["ru", "en"] as const;
export const currencies = ["RUB", "USD"] as const;
/** The notification sounds, made by Drimvox itself from tones (apps/web/src/lib/sounds.ts): no recordings, no licences. */
/** What the browser's address field searches with; "auto": Yandex in Russian, Bing in English (as it was). */
export const searchEngines = ["auto", "google", "yandex", "duckduckgo", "bing"] as const;
export type SearchEngine = (typeof searchEngines)[number];
/**
 * Agents that do not read AGENTS.md by default, each with the file it reads: a short pointer there (asked for; Codex,
 * Cursor, Kimi Code, Z Code, opencode and Amp read AGENTS.md themselves).
 */
export const agentFiles = ["claude", "gemini", "qwen", "copilot", "windsurf", "cline", "roo", "kilo", "trae", "kiro", "junie", "crush", "iflow"] as const;
export type AgentFile = (typeof agentFiles)[number];
export const agentFileNames: Record<AgentFile, string> = {
  claude: "CLAUDE.md",
  gemini: "GEMINI.md",
  qwen: "QWEN.md",
  copilot: ".github/copilot-instructions.md",
  windsurf: ".windsurf/rules/drimvox.md",
  cline: ".clinerules/drimvox.md",
  roo: ".roo/rules/drimvox.md",
  kilo: ".kilocode/rules/drimvox.md",
  trae: ".trae/rules/project_rules.md",
  kiro: ".kiro/steering/drimvox.md",
  junie: ".junie/guidelines.md",
  crush: "CRUSH.md",
  iflow: "IFLOW.md",
};
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
  /**
   * A cheaper model for the work around the work: sub-agents' research, summaries of long histories, the code review.
   * Null: the working model does it (asked for: fewer tokens, the same quality of what is built).
   */
  serviceModel: z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) }).nullable().default(null),
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
  cloudVoice: z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200), voice: z.string().min(1).max(120) }).nullable(),
  /** The most the whole app may spend in a calendar month, in dollars; null: no limit. */
  monthlyBudgetUsd: z.number().min(0.00001).max(100000).nullable(),
  /** A chat with a connected folder runs its commands without asking (asked for: a switch, auto or by hand). */
  folderAutoApprove: z.boolean(),
  /** Models the user starred: the picker's "Favourites" tab, across providers. */
  /** The browser's address field searches with it (asked for: a choice instead of Yandex alone). */
  searchEngine: z.enum(searchEngines),
  /** Pointer files to AGENTS.md for agents that read their own file (Claude Code, Gemini CLI, Qwen Code); none by default. */
  agentFiles: z.array(z.enum(agentFiles)).max(agentFiles.length),
  favoriteModels: z.array(z.object({ providerId: z.string().min(1), model: z.string().min(1).max(200) })).max(100),
});

export const settingsPatchSchema = settingsSchema.partial().strict();

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type Theme = Settings["theme"];
export type Locale = Settings["locale"];
export type Currency = Settings["currency"];

export const defaultSettings: Settings = {
  theme: "system",
  locale: "ru",
  currency: "RUB",
  agentBudgetUsd: 0.5,
  strongModel: null,
  imageModel: null,
  visionModel: null,
  serviceModel: null,
  acceptanceModel: null,
  notifications: true,
  notifySound: "drop",
  notifyVolume: 0.6,
  developer: false,
  folderAutoApprove: false,
  favoriteModels: [],
  searchEngine: "auto",
  agentFiles: [],
  monthlyBudgetUsd: null,
  voiceModel: null,
  dictationLanguage: "interface",
  speechVoice: null,
  cloudVoice: null,
};

/** A speech model of a connected provider, with its voices (docs/specs/local-speech.md). */
export interface CloudSpeechModel {
  providerId: string;
  provider: string;
  model: string;
  name: string;
  /** Costs nothing by the provider's catalog. */
  free: boolean;
  voices: string[];
}
