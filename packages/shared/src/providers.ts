import { z } from "zod";

export const presetIds = ["openrouter", "deepseek", "nvidia", "ollama", "lmstudio", "custom"] as const;
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
  /** How usage is billed: real money, provider credits, or nothing (local). */
  billing: "paid" | "credits" | "free";
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
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyRequired: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    editableUrl: false,
    billing: "paid",
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyRequired: true,
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    editableUrl: false,
    billing: "credits",
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyRequired: false,
    editableUrl: true,
    billing: "free",
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyRequired: false,
    editableUrl: true,
    billing: "free",
  },
  custom: {
    id: "custom",
    name: "OpenAI-совместимый",
    baseUrl: "",
    keyRequired: false,
    editableUrl: true,
    billing: "paid",
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
