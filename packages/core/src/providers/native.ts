import type { ModelInfo, PresetId } from "@drimvox/shared";
import { normalizeModels } from "./catalog";
import { fetchJson } from "./http";
import type { Connection } from "./repo";

/** Vendors that speak their own API; Drimvox reaches them through their AI SDK packages. */
export const NATIVE: PresetId[] = ["anthropic", "openai", "google", "xai"];

/**
 * Vendors do not publish prices through their APIs. OpenRouter's public catalog lists the same models at
 * the vendors' own prices, so Drimvox takes them from there and marks them as an estimate.
 */
let catalogUrl = "https://openrouter.ai/api/v1";
const PRICES_TTL = 24 * 60 * 60_000;
const CATALOG_WAIT_MS = 3_000;
let prices: { at: number; byKey: Map<string, ModelInfo>; byName: Map<string, ModelInfo> } | null = null;
let raw: { at: number; items: Record<string, unknown>[] } | null = null;

export function setPriceCatalogUrl(url: string | undefined): void {
  catalogUrl = url ?? "https://openrouter.ai/api/v1";
  prices = null;
  raw = null;
}

/** OpenRouter's public catalog as it is: every vendor's current models with names, dates and prices. Throws when out of reach. */
export async function catalogItems(fetchFn: typeof fetch = fetch): Promise<Record<string, unknown>[]> {
  if (raw && Date.now() - raw.at < PRICES_TTL) return raw.items;
  const body = (await fetchJson(`${catalogUrl}/models`, null, 15_000, {}, fetchFn)) as { data?: unknown[] };
  const items = (body.data ?? []).filter((i): i is Record<string, unknown> => !!i && typeof i === "object");
  raw = { at: Date.now(), items };
  return items;
}

const VENDOR_PREFIX: Partial<Record<PresetId, string>> = { anthropic: "anthropic", openai: "openai", google: "google", xai: "x-ai" };

/** "claude-sonnet-4-5-20250929" and "anthropic/claude-sonnet-4.5" both become "claude-sonnet-4-5". */
function key(id: string): string {
  return id
    .toLowerCase()
    .replace(/^[a-z-]+\//, "")
    .replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/[._]/g, "-");
}

async function priceTables(fetchFn: typeof fetch): Promise<{ byKey: Map<string, ModelInfo>; byName: Map<string, ModelInfo> }> {
  if (prices && Date.now() - prices.at < PRICES_TTL) return prices;
  const byKey = new Map<string, ModelInfo>();
  const byName = new Map<string, ModelInfo>();
  try {
    for (const m of normalizeModels("openrouter", await catalogItems(fetchFn))) {
      byKey.set(`${m.id.split("/")[0]}|${key(m.id)}`, m);
      // By the name alone, for providers that put their own prefix or none; a free variant (":free") prices nothing.
      if (!m.id.includes(":") && !byName.has(key(m.id))) byName.set(key(m.id), m);
    }
    prices = { at: Date.now(), byKey, byName };
  } catch {
    // Without the catalog prices are unknown; the next look tries again.
  }
  return { byKey, byName };
}

const priceTable = async (fetchFn: typeof fetch) => (await priceTables(fetchFn)).byKey;

/**
 * Prices for models a provider lists without them (seen: a custom OpenAI-style address gave none, and nothing was
 * counted): OpenRouter's public catalog by the model's name, whatever prefix the provider puts, marked as an estimate.
 */
export async function withCatalogPrices(models: ModelInfo[], fetchFn: typeof fetch): Promise<ModelInfo[]> {
  if (!models.some((m) => m.priceIn === null)) return models;
  // The list never waits long for an estimate: without the catalog in 3 seconds it comes unpriced, the next look has it.
  const loading = priceTables(fetchFn);
  const { byName } = await Promise.race([loading, new Promise<{ byName: Map<string, ModelInfo> }>((r) => setTimeout(() => r({ byName: new Map() }), CATALOG_WAIT_MS).unref())]);
  return models.map((m) => {
    if (m.priceIn !== null) return m;
    const known = byName.get(key(m.id));
    if (!known || known.priceIn === null) return m;
    return {
      ...m,
      priceIn: known.priceIn,
      priceOut: known.priceOut,
      priceEstimated: true,
      ...(known.priceCacheRead !== undefined ? { priceCacheRead: known.priceCacheRead } : {}),
      contextLength: m.contextLength ?? known.contextLength,
      tools: m.tools ?? known.tools,
      vision: m.vision ?? known.vision,
      ...(m.audio || known.audio ? { audio: true } : {}),
    };
  });
}

const GOOGLE_NOT_CHAT = /embedding|aqa|imagen|veo|tts|lyria|transcribe|robotics|deep-research|antigravity|computer-use|-latest$|-image\b|image-preview|nano-banana/i;

/**
 * Which Gemini API models a key without billing may use free, up to a daily limit. Google's API does not say it; its
 * pricing page (2026-10) gives a free tier to Flash, Flash-Lite, Gemma and 2.5 Pro, and none to newer Pro, Argon, Omni
 * and picture models.
 */
export function googleFreeTier(id: string): boolean {
  if (/gemma/i.test(id)) return true;
  if (/image|banana|omni|argon|customtools|veo|lyria/i.test(id)) return false;
  if (/-pro\b/i.test(id)) return /^gemini-2\.5-pro/i.test(id);
  return /flash/i.test(id);
}

interface Listed {
  id: string;
  name: string;
  contextLength: number | null;
}

/** The vendor's model list, without models that do not chat (embeddings, speech, pictures). */
async function vendorModels(conn: Connection): Promise<Listed[]> {
  if (conn.preset === "anthropic") {
    const body = (await fetchJson(
      `${conn.baseUrl}/models?limit=100`,
      null,
      15_000,
      { "x-api-key": conn.apiKey ?? "", "anthropic-version": "2023-06-01" },
      conn.fetch,
    )) as { data?: { id: string; display_name?: string }[] };
    return (body.data ?? []).map((m) => ({ id: m.id, name: m.display_name || m.id, contextLength: null }));
  }
  if (conn.preset === "google") {
    const body = (await fetchJson(`${conn.baseUrl}/models?pageSize=1000`, null, 15_000, { "x-goog-api-key": conn.apiKey ?? "" }, conn.fetch)) as {
      models?: { name: string; displayName?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }[];
    };
    return (body.models ?? [])
      // Music, speech, research and computer agents also "generate content", but not as a chat; "-latest" names repeat a listed model.
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && !GOOGLE_NOT_CHAT.test(m.name))
      .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name, contextLength: m.inputTokenLimit ?? null }));
  }
  const body = (await fetchJson(`${conn.baseUrl}/models`, conn.apiKey, 15_000, {}, conn.fetch)) as { data?: { id: string }[] };
  const notChat =
    conn.preset === "openai"
      ? /embedding|whisper|tts|dall-e|realtime|transcribe|moderation|audio|image|search|babbage|davinci|sora|computer-use/i
      : /image|imagine|video|vision-beta/i;
  return (body.data ?? []).filter((m) => !notChat.test(m.id)).map((m) => ({ id: m.id, name: m.id, contextLength: null }));
}

export async function nativeModels(conn: Connection): Promise<ModelInfo[]> {
  const [listed, table] = await Promise.all([vendorModels(conn), priceTable(conn.fetch)]);
  const prefix = VENDOR_PREFIX[conn.preset];
  return listed
    .map((m): ModelInfo => {
      const known = table.get(`${prefix}|${key(m.id)}`);
      return {
        id: m.id,
        name: m.name,
        contextLength: m.contextLength ?? known?.contextLength ?? null,
        priceIn: known?.priceIn ?? null,
        priceOut: known?.priceOut ?? null,
        priceEstimated: !!known,
        ...(known?.priceCacheRead !== undefined ? { priceCacheRead: known.priceCacheRead } : {}),
        tools: known?.tools ?? null,
        vision: known?.vision ?? null,
        ...(known?.audio ? { audio: true } : {}),
        ...(conn.preset === "google" ? { freeTier: googleFreeTier(m.id) } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
