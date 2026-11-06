import { withOllamaDetails } from "./ollama-details";
import { localModelTitle, presets, type Availability, type ModelInfo, type PresetId } from "@drimvox/shared";
import { fetchJson } from "./http";
import { usdPer } from "../rates";
import { NATIVE, nativeModels, withCatalogPrices } from "./native";
import { isCli } from "../cli/kinds";
import { cliModels } from "../cli/models";
import { localAudio } from "../local/audio/service";
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

/** Picture and video makers by their names, for catalogs that do not say what a model outputs (custom servers). */
const VIDEO_MAKER = /(^|[/._-])(veo|sora|kling|seedance|hailuo|minimax-video|wan-?2|hunyuan-?video|ltx-?video|runway|gen-?4|pika|luma|ray-?2|grok-imagine-video|cogvideo|mochi)([._-]|$)/i;
const IMAGE_MAKER = /(^|[/._-])(flux|recraft|sdxl|sd-?3|stable-diffusion|dall-?e|gpt-image|imagen|seedream|midjourney|ideogram|playground-v|hidream|kandinsky|qwen-image|nano-banana|grok-imagine|z-image|cogview)([._-]|$)|[-_]image(-preview|-generation)?$/i;

/** What a model makes when its catalog does not say: "image", "video", or null for a model that talks. */
export function mediaKindByName(id: string): "image" | "video" | null {
  if (VIDEO_MAKER.test(id)) return "video";
  if (IMAGE_MAKER.test(id)) return "image";
  return null;
}

/** Listed among chat models by every catalog, but they do not chat: safety classifiers and search rankers. */
const notChat = /content-safety|\bguard\b|-guard-|rerank/i;

type Raw = Record<string, unknown>;

/**
 * Chat models of a catalog. `toUsd` converts the catalog's prices to dollars (RouterAI prices in rubles).
 * Models that cannot chat (embeddings, speech, pictures, video) are left out; they live elsewhere.
 */
const namedFree = /[-:/_]free$|^free[/:_-]/i;

/**
 * What lists say of a model in their own words (asked for: BlazeAPI's free models showed as paid; seen: is_free, tags
 * "free" as a string, prices per million under their own names, the model's state).
 */
function saysFree(raw: Raw): boolean {
  const tags = raw.tags;
  return raw.is_free === true || raw.isFree === true || raw.free === true || (typeof tags === "string" && /\bfree\b/i.test(tags)) || (Array.isArray(tags) && tags.includes("free"));
}

/** A model a list says is down, closed to this key, or struggling; undefined when it says nothing. */
function listedState(raw: Raw): Availability | undefined {
  if (raw.available === false || raw.available_for_account === false || raw.globally_available === false) return "gone";
  const status = typeof raw.status === "string" ? raw.status.toLowerCase() : "";
  if (/^(down|offline|unavailable|disabled|maintenance|deprecated|retired)$/.test(status)) return "gone";
  if (/^(degraded|overloaded|busy|limited|partial_outage)$/.test(status)) return "busy";
  return undefined;
}
/** Catalogs that say what kind each model is (Vercel's `type`, LLM7's `model_type`): only these kinds chat. */
const chatKinds = /^(language|chat|llm|text)$/i;
/** Providers whose every model is free up to a limit on a key without billing (docs/specs/providers.md, checked 2026-11). */
const allFreeTier = new Set<PresetId>(["groq", "cerebras", "mistral", "cohere", "cloudflare", "ovhcloud", "ollamacloud", "gonka"]);

/** The cheapest live provider's prices behind a Hugging Face model, per 1M tokens, and whether one serves it free. */
function huggingFacePrices(raw: Raw): { in: number | null; out: number | null; free: boolean } {
  const live = (Array.isArray(raw.providers) ? raw.providers : []).filter((p): p is Raw => !!p && typeof p === "object" && (p as Raw).status !== "offline");
  const free = live.some((p) => p.is_free === true);
  const priced = live
    .map((p) => p.pricing as { input?: unknown; output?: unknown } | undefined)
    .filter((x): x is { input: number; output: number } => typeof x?.input === "number" && typeof x?.output === "number")
    .sort((a, b) => a.input + a.output - (b.input + b.output));
  return { in: priced[0]?.input ?? null, out: priced[0]?.output ?? null, free };
}

/** Whether a model is free up to a limit, by what its provider's catalog says (beyond a zero price). */
function freeTierOf(preset: PresetId, raw: Raw): boolean {
  if (allFreeTier.has(preset)) return true;
  // LLM7: its Turbo models answer free, even without a key (checked live); Pro ones need a paid key.
  if (preset === "llm7") return raw.tier === "turbo" && raw.usage_based_only !== true;
  if (preset === "huggingface") return huggingFacePrices(raw).free;
  // Zhipu's Flash models (GLM-4.7-Flash, GLM-4.6V-Flash…) are free; FlashX are not.
  if (preset === "zhipu") return typeof raw.id === "string" && /-flash$/i.test(raw.id);
  return raw.isFree === true || (Array.isArray(raw.tags) && raw.tags.includes("free"));
}

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
    // OpenRouter and its kin say it under "architecture"; DeepSeek's own API at the top level.
    // Vercel says it under "modalities".
    const out = (raw.architecture as { output_modalities?: unknown } | undefined)?.output_modalities ?? raw.output_modalities ?? (raw.modalities as { output?: unknown } | undefined)?.output;
    // Picture makers that also answer in text (Gemini "-image", Nano Banana, GPT-5 Image) live on the Pictures tab only
    // (seen: they were listed among the text models too).
    if (Array.isArray(out) && (!out.includes("text") || out.includes("audio") || out.includes("image") || out.includes("video"))) continue;
    // A catalog that does not say: picture and video makers by their names go to their own tabs (seen live).
    if (!Array.isArray(out) && mediaKindByName(id)) continue;
    const kind = raw.type ?? raw.model_type;
    if (typeof kind === "string" && !chatKinds.test(kind)) continue;

    const pricing = (raw.pricing ?? {}) as Raw;
    // Per token as OpenAI and OpenRouter write it ("prompt"/"completion"), or "input"/"output" (Vercel, LLM7); LLM7 and
    // Hugging Face give theirs per million tokens already (seen: 260 of Vercel's and LLM7's prices were "unknown").
    const perUnit = typeof pricing.unit === "string" && /1M/i.test(pricing.unit) ? 1_000_000 : 1;
    const hf = preset === "huggingface" ? huggingFacePrices(raw) : null;
    // models.dev's shape (OpenCode Zen): "cost" per million tokens.
    const cost = (raw.cost ?? {}) as Raw;
    const perM = (v: unknown) => (typeof v === "number" ? v / 1_000_000 : null);
    // Per million under a name of their own (BlazeAPI: price_in_per_m).
    const ownIn = perM(raw.price_in_per_m ?? raw.input_price_per_million);
    const ownOut = perM(raw.price_out_per_m ?? raw.output_price_per_million);
    let priceIn = hf ? perMillion(hf.in === null ? null : hf.in / 1_000_000, toUsd) : perMillion(scaled(pricing.prompt ?? pricing.input, perUnit) ?? perM(cost.input) ?? ownIn, toUsd);
    let priceOut = hf ? perMillion(hf.out === null ? null : hf.out / 1_000_000, toUsd) : perMillion(scaled(pricing.completion ?? pricing.output, perUnit) ?? perM(cost.output) ?? ownOut, toUsd);
    let priceCacheRead = perMillion(scaled(pricing.input_cache_read, perUnit), toUsd);
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
    // A list without prices that marks free models by name ("…-free", "…:free"; seen with Beatapi): those cost nothing.
    if ((priceIn === null && (free || namedFree.test(id))) || saysFree(raw)) {
      priceIn = 0;
      priceOut = 0;
    }

    const freeTier = !(priceIn === 0 && priceOut === 0) && freeTierOf(preset, raw);
    const params = raw.supported_parameters;
    const inputs = (raw.architecture as { input_modalities?: unknown } | undefined)?.input_modalities ?? raw.input_modalities;
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
      ...(Array.isArray(inputs) && inputs.includes("audio") ? { audio: true } : {}),
      ...(freeTier ? { freeTier: true } : {}),
      ...(listedState(raw) ? { available: listedState(raw) } : {}),
    });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/** A price given per `unit` tokens, as a price per token. */
function scaled(value: unknown, unit: number): unknown {
  if (unit === 1) return value;
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(n) ? n / unit : value;
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
  // The chains of free models are this provider's models.
  if (conn.chain) return conn.chain.models();
  // A CLI's list is cheap to build and shows the model its default last turned out to be.
  if (isCli(conn.preset)) return cliModels({ ...conn, preset: conn.preset });
  // Pictures on this computer have no models to talk to (docs/specs/local-images.md).
  if (conn.preset === "sdcpp") return [];
  // Speech on this computer (docs/specs/local-audio.md): the downloaded models, all of which hear.
  if (conn.preset === "whispercpp")
    return (localAudio()?.installed() ?? []).map((m) => ({ id: m.id, name: m.name, contextLength: null, priceIn: 0, priceOut: 0, priceEstimated: false, tools: false, vision: false, audio: true }));
  const hit = cache.get(conn.cacheKey);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.models;
  let models: ModelInfo[];
  if (NATIVE.includes(conn.preset)) models = await nativeModels(conn);
  else {
    // Perplexity answers at its root but lists its models under /v1.
    // Cloudflare answers at /ai/v1 but lists its models at /ai/models/search, by task.
    const listUrl =
      conn.preset === "perplexity"
        ? `${conn.baseUrl}/v1/models`
        : conn.preset === "cloudflare"
          ? `${conn.baseUrl.replace(/\/v1\/?$/, "")}/models/search?task=Text%20Generation&per_page=200`
          : `${conn.baseUrl}/models`;
    const body = (await fetchJson(listUrl, conn.apiKey, 15_000, {}, conn.fetch)) as { data?: unknown; result?: unknown };
    const items =
      conn.preset === "cloudflare" && Array.isArray(body?.result)
        ? (body.result as Raw[]).map((m) => ({ id: m.name, name: m.name, context_length: undefined }))
        : Array.isArray(body)
          ? body
          : Array.isArray(body?.data)
            ? body.data
            : [];
    models = normalizeModels(conn.preset, items, await usdPer(conn.currency));
    if (conn.preset === "ollama") models = (await withOllamaDetails(conn, models)).map((m) => (m.name === m.id ? { ...m, name: localModelTitle(m.id).title } : m));
    // A flat fee: nothing per answer. OpenRouter and RouterAI price their own models; a model without a price there is
    // priced per request, not missing. Others get the catalog's estimate.
    if (conn.flat) models = models.map((m) => ({ ...m, priceIn: 0, priceOut: 0, priceEstimated: false }));
    else if (conn.preset !== "openrouter" && conn.preset !== "routerai") models = await withCatalogPrices(models, conn.fetch);
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
