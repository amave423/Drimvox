import { z } from "zod";

export const presetIds = [
  "openrouter",
  "routerai",
  "claude-code",
  "codex",
  "gemini-cli",
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "nvidia",
  "ollama",
  "lmstudio",
  "custom",
] as const;
export type PresetId = (typeof presetIds)[number];

export interface Preset {
  id: PresetId;
  name: string;
  baseUrl: string;
  /** Local servers run without a key. */
  keyRequired: boolean;
  /** Where to get a key; shown next to the key field. */
  keyUrl?: string;
  /** The user may change the address (local servers and custom endpoints). */
  editableUrl: boolean;
  /** How usage is billed: real money, provider credits, the user's subscription to a CLI, or nothing (local). */
  billing: "paid" | "credits" | "subscription" | "free";
  /** A command-line agent Artel runs instead of calling an API: its program and how to install it. */
  cli?: { command: string; install: string };
  /** What the provider's prices and costs are in. Artel converts rubles to dollars internally. */
  currency: "USD" | "RUB";
}

export const presets: Record<PresetId, Preset> = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyRequired: true,
    keyUrl: "https://openrouter.ai/settings/keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  routerai: {
    id: "routerai",
    name: "RouterAI",
    baseUrl: "https://routerai.ru/api/v1",
    keyRequired: true,
    keyUrl: "https://routerai.ru/",
    editableUrl: false,
    billing: "paid",
    currency: "RUB",
  },
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    baseUrl: "",
    keyRequired: false,
    editableUrl: false,
    billing: "subscription",
    currency: "USD",
    cli: { command: "claude", install: "npm install -g @anthropic-ai/claude-code" },
  },
  codex: {
    id: "codex",
    name: "Codex",
    baseUrl: "",
    keyRequired: false,
    editableUrl: false,
    billing: "subscription",
    currency: "USD",
    cli: { command: "codex", install: "npm install -g @openai/codex" },
  },
  "gemini-cli": {
    id: "gemini-cli",
    name: "Gemini CLI",
    baseUrl: "",
    keyRequired: false,
    editableUrl: false,
    billing: "subscription",
    currency: "USD",
    cli: { command: "gemini", install: "npm install -g @google/gemini-cli" },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyRequired: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyRequired: true,
    keyUrl: "https://platform.openai.com/api-keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  google: {
    id: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyRequired: true,
    keyUrl: "https://aistudio.google.com/apikey",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  xai: {
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    keyRequired: true,
    keyUrl: "https://console.x.ai/",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyRequired: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyRequired: true,
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    editableUrl: false,
    billing: "credits",
    currency: "USD",
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyRequired: false,
    editableUrl: true,
    billing: "free",
    currency: "USD",
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyRequired: false,
    editableUrl: true,
    billing: "free",
    currency: "USD",
  },
  custom: {
    id: "custom",
    name: "OpenAI-совместимый",
    baseUrl: "",
    keyRequired: false,
    editableUrl: true,
    billing: "paid",
    currency: "USD",
  },
};

const baseUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//.test(u), "http or https only")
  .transform((u) => u.replace(/\/+$/, ""));

export const providerCreateSchema = z
  .object({
    preset: z.enum(presetIds),
    name: z.string().trim().min(1).max(60).optional(),
    baseUrl: baseUrlSchema.optional(),
    apiKey: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const providerUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    baseUrl: baseUrlSchema.optional(),
    apiKey: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type ProviderCreate = z.infer<typeof providerCreateSchema>;
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;

/** What the API returns about a provider. The key itself never leaves the core. */
export interface ProviderView {
  id: string;
  preset: PresetId;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  billing: Preset["billing"];
  currency: Preset["currency"];
  createdAt: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per 1M tokens; null when the provider does not publish prices. */
  priceIn: number | null;
  priceOut: number | null;
  /** True when prices come from a table built into Artel rather than from the provider. */
  priceEstimated: boolean;
  tools: boolean | null;
  /** Understands pictures in the prompt; null when the catalog does not say. */
  vision: boolean | null;
}

/** Problems talking to a provider, as codes the UI translates. */
export const providerErrorCodes = [
  "bad_key",
  "no_funds",
  "rate_limited",
  "model_not_found",
  "provider_error",
  "unreachable",
  "timeout",
  "no_key",
  /** A command-line agent is not installed. */
  "cli_missing",
  /** A command-line agent is installed but not logged in to its account. */
  "cli_login",
  "unknown",
] as const;
export type ProviderErrorCode = (typeof providerErrorCodes)[number];

export interface ProviderError {
  code: ProviderErrorCode;
  /** The provider's own wording, if any. Never contains the key. */
  detail?: string;
}

export interface Balance {
  amount: number;
  currency: string;
}
