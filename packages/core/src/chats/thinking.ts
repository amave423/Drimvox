import type { PresetId, ThinkingLevel } from "@drimvox/shared";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** Options for the request body, per provider, as the AI SDK takes them. */
export type ProviderBody = Record<string, { [key: string]: Json }>;

/** Thinking budgets in tokens for providers that take a number. */
const BUDGET: Record<Exclude<ThinkingLevel, "auto" | "off">, number> = { low: 2000, medium: 8000, high: 24000 };

/**
 * How much a model thinks before it answers, as each provider is told; undefined leaves the provider's own default
 * (seen live: left to itself, a model thought 90 000 characters and wrote no answer).
 */
export function thinkingOptions(preset: PresetId, level: ThinkingLevel): ProviderBody | undefined {
  if (level === "auto") return undefined;
  switch (preset) {
    case "openrouter":
    case "routerai":
    case "custom":
      return { [preset]: { reasoning: level === "off" ? { enabled: false } : { effort: level } } };
    case "deepseek":
      return { deepseek: { thinking: { type: level === "off" ? "disabled" : "enabled" } } };
    case "anthropic":
      return { anthropic: { thinking: level === "off" ? { type: "disabled" } : { type: "enabled", budgetTokens: BUDGET[level] } } };
    case "openai":
      return { openai: { reasoningEffort: level === "off" ? "minimal" : level } };
    case "xai":
      return level === "off" ? undefined : { xai: { reasoningEffort: level === "high" ? "high" : "low" } };
    case "google":
      return { google: { thinkingConfig: { thinkingBudget: level === "off" ? 0 : BUDGET[level] } } };
    default:
      // Local models and command-line agents keep their own way of thinking.
      return undefined;
  }
}

/** Provider options from several sources, merged per provider. */
export function mergeOptions(...parts: (ProviderBody | undefined)[]): ProviderBody | undefined {
  const merged: ProviderBody = {};
  for (const part of parts) for (const [key, value] of Object.entries(part ?? {})) merged[key] = { ...merged[key], ...value };
  return Object.keys(merged).length ? merged : undefined;
}
