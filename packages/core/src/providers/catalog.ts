import { presets, type ModelInfo, type PresetId } from "@artel/shared";
import { fetchJson } from "./http";
import type { Connection } from "./repo";

/**
 * DeepSeek does not publish prices through its API. USD per 1M tokens, cache-miss input,
 * from the public price list (Dec 2025). Shown in the UI as an estimate.
 */
const deepseekPrices: Record<string, [number, number]> = {
  "deepseek-chat": [0.28, 0.42],
  "deepseek-reasoner": [0.28, 0.42],
};

type Raw = Record<string, unknown>;

export function normalizeModels(preset: PresetId, items: unknown[]): ModelInfo[] {
  const free = presets[preset].billing === "free";
  const models: ModelInfo[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Raw;
    if (typeof raw.id !== "string" || !raw.id) continue;

    let priceIn = perMillion((raw.pricing as Raw | undefined)?.prompt);
    let priceOut = perMillion((raw.pricing as Raw | undefined)?.completion);
    let priceEstimated = false;
    const table = preset === "deepseek" ? deepseekPrices[raw.id] : undefined;
    if (priceIn === null && table) {
      [priceIn, priceOut] = table;
      priceEstimated = true;
    }
    if (priceIn === null && free) {
      priceIn = 0;
      priceOut = 0;
    }

    const params = raw.supported_parameters;
    models.push({
      id: raw.id,
      name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
      contextLength: numberOrNull(raw.context_length ?? raw.context_window ?? raw.max_model_len),
      priceIn,
      priceOut,
      priceEstimated,
      tools: Array.isArray(params) ? params.includes("tools") : null,
    });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/** Prices arrive as USD per token strings; "-1" means "varies". */
function perMillion(value: unknown): number | null {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1_000_000).toFixed(6));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; models: ModelInfo[] }>();

export async function listModels(conn: Connection, fresh = false): Promise<ModelInfo[]> {
  const hit = cache.get(conn.cacheKey);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.models;
  const body = (await fetchJson(`${conn.baseUrl}/models`, conn.apiKey)) as { data?: unknown };
  const items = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  const models = normalizeModels(conn.preset, items);
  cache.set(conn.cacheKey, { at: Date.now(), models });
  return models;
}

/** Price of a model if the catalog knows it; never throws. */
export async function findModel(conn: Connection, modelId: string): Promise<ModelInfo | undefined> {
  try {
    return (await listModels(conn)).find((m) => m.id === modelId);
  } catch {
    return undefined;
  }
}
