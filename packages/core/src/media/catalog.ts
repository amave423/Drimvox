import type { MediaKind, MediaModel, PriceLine } from "@artel/shared";
import { fetchJson } from "../providers/http";
import type { Connection } from "../providers/repo";

type Raw = Record<string, unknown>;

const TTL_MS = 10 * 60_000;
const lists = new Map<string, { at: number; models: MediaModel[] }>();
const prices = new Map<string, { at: number; lines: PriceLine[] }>();

/** Only OpenRouter has a media API among the presets; a custom server may have one too. */
const mayHaveMedia = (conn: Connection) => conn.preset === "openrouter" || conn.preset === "custom";

/** Image or video models of a provider. A provider without a media API simply has none. */
export async function listMediaModels(conn: Connection, kind: MediaKind): Promise<MediaModel[]> {
  if (!mayHaveMedia(conn)) return [];
  const key = `${conn.cacheKey}|${kind}`;
  const hit = lists.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;
  let items: unknown[] = [];
  try {
    const body = (await fetchJson(`${conn.baseUrl}/${kind === "image" ? "images" : "videos"}/models`, conn.apiKey)) as { data?: unknown };
    items = Array.isArray(body?.data) ? body.data : [];
  } catch {
    return [];
  }
  const models = items.flatMap((item) => (item && typeof item === "object" ? [normalize(kind, item as Raw)] : [])).filter((m) => m.id);
  lists.set(key, { at: Date.now(), models });
  return models;
}

/** One model with its prices, ready for an estimate. Null when the provider does not list it. */
export async function mediaModel(conn: Connection, kind: MediaKind, id: string): Promise<MediaModel | null> {
  const model = (await listMediaModels(conn, kind)).find((m) => m.id === id);
  if (!model) return null;
  if (kind === "video") return model;
  return { ...model, pricing: { lines: await imagePrices(conn, id), skus: {} } };
}

async function imagePrices(conn: Connection, id: string): Promise<PriceLine[]> {
  const key = `${conn.cacheKey}|${id}`;
  const hit = prices.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.lines;
  let lines: PriceLine[] = [];
  try {
    const body = (await fetchJson(`${conn.baseUrl}/images/models/${id}/endpoints`, conn.apiKey)) as { endpoints?: { pricing?: unknown }[] };
    // The first endpoint is the one OpenRouter routes to by default.
    const raw = body?.endpoints?.[0]?.pricing;
    lines = Array.isArray(raw)
      ? raw.flatMap((l: Raw) =>
          typeof l.billable === "string" && typeof l.unit === "string" && typeof l.cost_usd === "number"
            ? [{ billable: l.billable, unit: l.unit, costUsd: l.cost_usd, variant: typeof l.variant === "string" ? l.variant : null }]
            : [],
        )
      : [];
  } catch {
    lines = [];
  }
  prices.set(key, { at: Date.now(), lines });
  return lines;
}

function normalize(kind: MediaKind, raw: Raw): MediaModel {
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" && raw.name ? raw.name : id;
  if (kind === "image") {
    const params = (raw.supported_parameters ?? {}) as Record<string, { values?: unknown }>;
    return {
      id,
      name,
      kind,
      aspectRatios: strings(params.aspect_ratio?.values),
      resolutions: strings(params.resolution?.values),
      durations: [],
      audio: false,
      pricing: null,
    };
  }
  const skus = raw.pricing_skus && typeof raw.pricing_skus === "object" ? (raw.pricing_skus as Record<string, unknown>) : {};
  return {
    id,
    name,
    kind,
    aspectRatios: strings(raw.supported_aspect_ratios),
    resolutions: strings(raw.supported_resolutions),
    durations: Array.isArray(raw.supported_durations)
      ? raw.supported_durations.filter((d): d is number => typeof d === "number").sort((a, b) => a - b)
      : [],
    audio: raw.generate_audio === true,
    pricing: { lines: [], skus: Object.fromEntries(Object.entries(skus).map(([k, v]) => [k, String(v)])) },
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
