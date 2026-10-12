import type { ModelInfo, PresetId } from "@artel/shared";
import { normalizeModels } from "./catalog";
import { fetchJson } from "./http";
import type { Connection } from "./repo";

/** Vendors that speak their own API; Artel reaches them through their AI SDK packages. */
export const NATIVE: PresetId[] = ["anthropic", "openai", "google", "xai"];

/**
 * Vendors do not publish prices through their APIs. OpenRouter's public catalog lists the same models at
 * the vendors' own prices, so Artel takes them from there and marks them as an estimate.
 */
let catalogUrl = "https://openrouter.ai/api/v1";
const PRICES_TTL = 24 * 60 * 60_000;
let prices: { at: number; byKey: Map<string, ModelInfo> } | null = null;

export function setPriceCatalogUrl(url: string | undefined): void {
  catalogUrl = url ?? "https://openrouter.ai/api/v1";
  prices = null;
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

async function priceTable(): Promise<Map<string, ModelInfo>> {
  if (prices && Date.now() - prices.at < PRICES_TTL) return prices.byKey;
  const byKey = new Map<string, ModelInfo>();
  try {
    const body = (await fetchJson(`${catalogUrl}/models`, null)) as { data?: unknown[] };
    for (const m of normalizeModels("openrouter", body.data ?? [])) byKey.set(`${m.id.split("/")[0]}|${key(m.id)}`, m);
    prices = { at: Date.now(), byKey };
  } catch {
    // Without the catalog prices are unknown; the next look tries again.
  }
  return byKey;
}

interface Listed {
  id: string;
  name: string;
  contextLength: number | null;
}

/** The vendor's model list, without models that do not chat (embeddings, speech, pictures). */
async function vendorModels(conn: Connection): Promise<Listed[]> {
  if (conn.preset === "anthropic") {
    const body = (await fetchJson(`${conn.baseUrl}/models?limit=100`, null, 15_000, {
      "x-api-key": conn.apiKey ?? "",
      "anthropic-version": "2023-06-01",
    })) as { data?: { id: string; display_name?: string }[] };
    return (body.data ?? []).map((m) => ({ id: m.id, name: m.display_name || m.id, contextLength: null }));
  }
  if (conn.preset === "google") {
    const body = (await fetchJson(`${conn.baseUrl}/models?pageSize=1000`, null, 15_000, { "x-goog-api-key": conn.apiKey ?? "" })) as {
      models?: { name: string; displayName?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }[];
    };
    return (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && !/embedding|aqa|imagen|veo|tts/i.test(m.name))
      .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name, contextLength: m.inputTokenLimit ?? null }));
  }
  const body = (await fetchJson(`${conn.baseUrl}/models`, conn.apiKey)) as { data?: { id: string }[] };
  const notChat =
    conn.preset === "openai"
      ? /embedding|whisper|tts|dall-e|realtime|transcribe|moderation|audio|image|search|babbage|davinci|sora|computer-use/i
      : /image|imagine|video|vision-beta/i;
  return (body.data ?? []).filter((m) => !notChat.test(m.id)).map((m) => ({ id: m.id, name: m.id, contextLength: null }));
}

export async function nativeModels(conn: Connection): Promise<ModelInfo[]> {
  const [listed, table] = await Promise.all([vendorModels(conn), priceTable()]);
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
        tools: known?.tools ?? null,
        vision: known?.vision ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
