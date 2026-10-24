import type { ModelInfo, PresetId } from "@drimvox/shared";

export interface TokenUsage {
  /** Every input token, the cached ones included. */
  input: number;
  /** Input the provider served from its cache: billed at the cache price where it publishes one. */
  cacheRead: number;
  output: number;
}

/**
 * DeepSeek bills half outside its peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday
 * (api-docs.deepseek.com/quick_start/pricing, checked 2026-10-13). Chinese holidays are off-peak too; not known here,
 * so those days are counted at the peak price and the estimate errs high.
 */
function deepseekOffPeak(at: Date): boolean {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  if (day === 0 || day === 6) return true;
  return !((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

/** What a model call cost in dollars; null when the model's prices are unknown. */
export function costOf(model: ModelInfo | undefined, preset: PresetId, usage: TokenUsage, at: Date = new Date()): number | null {
  if (!model || model.priceIn === null || model.priceOut === null) return null;
  const cached = Math.min(usage.cacheRead, usage.input);
  const cachePrice = model.priceCacheRead ?? model.priceIn;
  const full = (usage.input - cached) * model.priceIn + cached * cachePrice + usage.output * model.priceOut;
  const factor = preset === "deepseek" && deepseekOffPeak(at) ? 0.5 : 1;
  // Rounded to a billionth of a dollar so sums do not show float noise like 0.00006089999999.
  return Number(((full * factor) / 1_000_000).toFixed(9));
}

/** The usage the AI SDK reports for a step or an answer, as Drimvox prices it. */
export function usageOf(u: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } } | undefined): TokenUsage {
  return { input: u?.inputTokens ?? 0, cacheRead: u?.inputTokenDetails?.cacheReadTokens ?? 0, output: u?.outputTokens ?? 0 };
}

/** The provider's own bill for a step in dollars, when it sent one (see `billed` in model.ts); null otherwise. */
export function billedUsd(providerMetadata: unknown, usdPerUnit: number): number | null {
  const billed = (providerMetadata as { drimvox?: { billed?: unknown } } | undefined)?.drimvox?.billed;
  return typeof billed === "number" ? billed * usdPerUnit : null;
}
