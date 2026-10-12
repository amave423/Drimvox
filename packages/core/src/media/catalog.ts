import type { MediaKind, MediaModel, PriceLine } from "@artel/shared";
import { fetchJson } from "../providers/http";
import type { Connection } from "../providers/repo";
import { usdPer } from "../rates";

type Raw = Record<string, unknown>;

const TTL_MS = 10 * 60_000;
const lists = new Map<string, { at: number; models: MediaModel[] }>();
const prices = new Map<string, { at: number; lines: PriceLine[] }>();

/**
 * OpenRouter keeps media models in their own catalogs; RouterAI lists every kind of model in /models.
 * A custom server may follow either; one without a media API simply has no media models.
 */
const style = (conn: Connection): "separate" | "combined" | null =>
  conn.preset === "routerai" ? "combined" : conn.preset === "openrouter" || conn.preset === "custom" ? "separate" : null;

/** Image or video models of a provider, sorted by name, prices in dollars where the catalog has them. */
export async function listMediaModels(conn: Connection, kind: MediaKind): Promise<MediaModel[]> {
  const how = style(conn);
  if (!how) return [];
  const key = `${conn.cacheKey}|${kind}`;
  const hit = lists.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;
  let items: Raw[] = [];
  try {
    const url = how === "combined" ? `${conn.baseUrl}/models` : `${conn.baseUrl}/${kind === "image" ? "images" : "videos"}/models`;
    const body = (await fetchJson(url, conn.apiKey)) as { data?: unknown };
    items = (Array.isArray(body?.data) ? body.data : []).filter((i): i is Raw => !!i && typeof i === "object");
  } catch {
    return [];
  }
  if (how === "combined") items = items.filter((i) => outputs(i).includes(kind));
  const factor = await usdPer(conn.currency);
  const models = items
    .map((item) => normalize(kind, item, how === "combined" ? factor : null))
    .filter((m) => m.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  lists.set(key, { at: Date.now(), models });
  return models;
}

/** One model with its prices, ready for an estimate. Null when the provider does not list it. */
export async function mediaModel(conn: Connection, kind: MediaKind, id: string): Promise<MediaModel | null> {
  const model = (await listMediaModels(conn, kind)).find((m) => m.id === id);
  if (!model) return null;
  if (model.pricing) return model;
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
    const factor = await usdPer(conn.currency);
    lines = Array.isArray(raw)
      ? raw.flatMap((l: Raw) =>
          typeof l.billable === "string" && typeof l.unit === "string" && typeof l.cost_usd === "number"
            ? [{ billable: l.billable, unit: l.unit, costUsd: round(l.cost_usd * factor), variant: typeof l.variant === "string" ? l.variant : null }]
            : [],
        )
      : [];
  } catch {
    lines = [];
  }
  prices.set(key, { at: Date.now(), lines });
  return lines;
}

function outputs(raw: Raw): string[] {
  const arch = raw.architecture as { output_modalities?: unknown } | undefined;
  return strings(arch?.output_modalities);
}

/**
 * `factor` turns the combined catalog's prices into dollars; null for OpenRouter-style catalogs, whose image
 * prices come later from the endpoints list.
 */
function normalize(kind: MediaKind, raw: Raw, factor: number | null): MediaModel {
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" && raw.name ? raw.name : id;
  const pricing = (raw.pricing ?? {}) as Record<string, unknown>;
  const units = (raw.pricing_units ?? {}) as Record<string, unknown>;

  if (kind === "image") {
    const params = (raw.supported_parameters ?? {}) as Record<string, { values?: unknown }>;
    let lines: PriceLine[] | null = null;
    if (factor !== null) {
      const table = Array.isArray(raw.image_pricing) ? (raw.image_pricing as Raw[]) : [];
      lines = table.flatMap((l) =>
        typeof l.unit === "string" && typeof l.price === "number"
          ? [{ billable: "output_image", unit: l.unit, costUsd: round(l.price * factor), variant: typeof l.variant === "string" ? l.variant : null }]
          : [],
      );
      if (lines.length === 0 && typeof pricing.image_output === "number") {
        lines = [{ billable: "output_image", unit: String(units.image_output ?? "image"), costUsd: round(pricing.image_output * factor), variant: null }];
      }
    }
    return {
      id,
      name,
      kind,
      aspectRatios: strings(raw.supported_aspect_ratios).length ? strings(raw.supported_aspect_ratios) : strings(params.aspect_ratio?.values),
      resolutions: strings(params.resolution?.values),
      durations: [],
      audio: false,
      viaChat: outputs(raw).includes("text"),
      pricing: lines === null ? null : { lines, skus: {} },
    };
  }

  // OpenRouter: named price keys (`pricing_skus`). RouterAI: one price per second of video.
  const skus: Record<string, string> =
    raw.pricing_skus && typeof raw.pricing_skus === "object"
      ? Object.fromEntries(Object.entries(raw.pricing_skus as Raw).map(([k, v]) => [k, String(v)]))
      : factor !== null && typeof pricing.seconds === "number"
        ? { duration_seconds: String(round(pricing.seconds * factor)) }
        : {};
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
    viaChat: false,
    pricing: { lines: [], skus },
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function round(n: number): number {
  return Number(n.toFixed(6));
}
