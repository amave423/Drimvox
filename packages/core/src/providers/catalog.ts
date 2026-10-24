import { withOllamaDetails } from "./ollama-details";
import { presets, type ModelInfo, type PresetId } from "@drimvox/shared";
import { fetchJson } from "./http";
import { usdPer } from "../rates";
import { NATIVE, nativeModels } from "./native";
import { isCli } from "../cli/kinds";
import { cliModels } from "../cli/models";
import type { Connection } from "./repo";

/**
 * DeepSeek does not publish prices through its API. USD per 1M tokens from
 * api-docs.deepseek.com/quick_start/pricing (checked 2026-10-13), at the peak-hour rate: input, output, input served
 * from the cache. costOf halves them outside peak hours. Legacy names are served by the Flash model at Flash prices.
 */
const flash: [number, number, number] = [0.3, 1.2, 0.006];
const deepseekPrices: Record<string, [number, number, number]> = {
  "deepseek-flash": flash,
  "deepseek-v4-pro": [1.32, 3.96, 0.044],
  "deepseek-v4-flash": flash,
  "deepseek-chat": flash,
  "deepseek-reasoner": flash,
};

/** NVIDIA lists embedding, safety, parsing and vision-detection models next to chat models. */
const nvidiaNonChat = /embed|retriever|reward|guard|safety|parse|clip|detector|calibration|deplot|kosmos|riva-translate/i;

/** Listed among chat models by every catalog, but they do not chat: safety classifiers and search rankers. */
const notChat = /content-safety|guard|-guard-|rerank/i;

type Raw = Record<string, unknown>;

/**
 * Chat models of a catalog. `toUsd` converts the catalog's prices to dollars (RouterAI prices in rubles).
 * Models that cannot chat (embeddings, speech, pictures, video) are left out; they live elsewhere.
 */
export function normalizeModels(preset: PresetId, items: unknown[], toUsd = 1): ModelInfo[] {
  // Local models cost nothing; NVIDIA's hosted models run on free developer credits, not money.
  const free = presets[preset].billing !== "paid";
  const models: ModelInfo[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Raw;
    if (typeof raw.id !== "string" || !raw.id) continue;
    // Google's OpenAI-style address lists "models/gemini-…"; its chat requests take the name alone.
    const id = raw.id.replace(/^models\//, "");
    if (preset === "nvidia" && nvidiaNonChat.test(raw.id)) continue;
    if (notChat.test(raw.id)) continue;
    // Music and speech models list text among their outputs too; a chat with them fails.
    const out = (raw.architecture as { output_modalities?: unknown } | undefined)?.output_modalities;
    if (Array.isArray(out) && (!out.includes("text") || out.includes("audio"))) continue;

    let priceIn = perMillion((raw.pricing as Raw | undefined)?.prompt, toUsd);
    let priceOut = perMillion((raw.pricing as Raw | undefined)?.completion, toUsd);
    let priceCacheRead = perMillion((raw.pricing as Raw | undefined)?.input_cache_read, toUsd);
    let priceEstimated = false;
    // Paid per request (music, some search models) with no token price: not free, and its token price says nothing.
    const perRequest = perMillion((raw.pricing as Raw | undefined)?.request, toUsd);
    if (perRequest && priceIn === 0 && priceOut === 0) {
      priceIn = null;
      priceOut = null;
    }
    const table = preset === "deepseek" ? deepseekPrices[raw.id] : undefined;
    if (priceIn === null && table) {
      [priceIn, priceOut, priceCacheRead] = table;
      priceEstimated = true;
    }
    if (priceIn === null && free) {
      priceIn = 0;
      priceOut = 0;
    }

    const params = raw.supported_parameters;
    const inputs = (raw.architecture as { input_modalities?: unknown } | undefined)?.input_modalities;
    models.push({
      id,
      name: typeof raw.name === "string" && raw.name ? raw.name : id,
      contextLength: numberOrNull(raw.context_length ?? raw.context_window ?? raw.max_model_len),
      priceIn,
      priceOut,
      priceEstimated,
      ...(priceCacheRead !== null && priceIn !== null && priceCacheRead < priceIn ? { priceCacheRead } : {}),
      tools: Array.isArray(params) ? params.includes("tools") : null,
      vision: Array.isArray(inputs) ? inputs.includes("image") : null,
    });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/** Prices arrive per token, as strings or numbers; "-1" means "varies". */
function perMillion(value: unknown, toUsd: number): number | null {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1_000_000 * toUsd).toFixed(6));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; models: ModelInfo[] }>();

export async function listModels(conn: Connection, fresh = false): Promise<ModelInfo[]> {
  // A CLI's list is cheap to build and shows the model its default last turned out to be.
  if (isCli(conn.preset)) return cliModels({ ...conn, preset: conn.preset });
  // Pictures on this computer have no models to talk to (docs/specs/local-images.md).
  if (conn.preset === "sdcpp") return [];
  const hit = cache.get(conn.cacheKey);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.models;
  let models: ModelInfo[];
  if (NATIVE.includes(conn.preset)) models = await nativeModels(conn);
  else {
    const body = (await fetchJson(`${conn.baseUrl}/models`, conn.apiKey, 15_000, {}, conn.fetch)) as { data?: unknown };
    const items = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    models = normalizeModels(conn.preset, items, await usdPer(conn.currency));
    if (conn.preset === "ollama") models = await withOllamaDetails(conn, models);
  }
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
