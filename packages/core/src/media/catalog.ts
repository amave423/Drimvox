import type { MediaKind, MediaModel, PriceLine } from "@drimvox/shared";
import { mediaKindByName } from "../providers/catalog";
import { fetchJson } from "../providers/http";
import type { Connection } from "../providers/repo";
import { usdPer } from "../rates";
import { localMediaModels } from "./local";

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
  // Pictures on this computer: the downloaded models, no catalog to ask.
  if (conn.preset === "sdcpp") return localMediaModels(kind);
  // Gemini lists its picture models among the others; NVIDIA keeps them off its list (seen: both had none here).
  if (conn.preset === "google") return kind === "image" ? cached(conn, kind, () => geminiImageModels(conn)) : [];
  if (conn.preset === "nvidia") return kind === "image" ? NVIDIA_IMAGES.map(nvidiaModel) : [];
  const how = style(conn);
  if (!how) return [];
  const key = `${conn.cacheKey}|${kind}`;
  const hit = lists.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;
  let items: Raw[] = [];
  try {
    const url = how === "combined" ? `${conn.baseUrl}/models` : `${conn.baseUrl}/${kind === "image" ? "images" : "videos"}/models`;
    const body = (await fetchJson(url, conn.apiKey, 15_000, {}, conn.fetch)) as { data?: unknown };
    items = (Array.isArray(body?.data) ? body.data : []).filter((i): i is Raw => !!i && typeof i === "object");
  } catch {
    // No media catalog at this address: a custom server may still list picture models among its chat models (below).
    if (conn.preset !== "custom") return [];
  }
  if (how === "combined") items = items.filter((i) => outputs(i).includes(kind));
  const factor = await usdPer(conn.currency);
  let models = items
    .map((item) => normalize(kind, item, how === "combined" ? factor : null))
    .filter((m) => m.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  // A custom server without a media catalog: its picture models are among its chat models (seen live). They draw through
  // OpenAI's images API, Gemini-style ones through the chat; clips have no common API, so none are offered.
  if (models.length === 0 && conn.preset === "custom" && kind === "image") models = await namedImageModels(conn);
  lists.set(key, { at: Date.now(), models });
  return models;
}

async function cached(conn: Connection, kind: MediaKind, load: () => Promise<MediaModel[]>): Promise<MediaModel[]> {
  const key = `${conn.cacheKey}|${kind}`;
  const hit = lists.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;
  const models = await load().catch(() => []);
  lists.set(key, { at: Date.now(), models });
  return models;
}

const ASPECTS = ["1:1", "3:4", "4:3", "9:16", "16:9"];

/** Gemini's picture models ("…-image", Nano Banana): drawn by generateContent, with photos as references. */
async function geminiImageModels(conn: Connection): Promise<MediaModel[]> {
  const body = (await fetchJson(`${conn.baseUrl}/models?pageSize=1000`, null, 15_000, { "x-goog-api-key": conn.apiKey ?? "" }, conn.fetch)) as {
    models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
  };
  return (body.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /-image\b|image-preview|nano-banana/i.test(m.name))
    .map((m): MediaModel => ({
      id: m.name.replace(/^models\//, ""),
      name: m.displayName || m.name.replace(/^models\//, ""),
      kind: "image",
      aspectRatios: ASPECTS,
      resolutions: [],
      durations: [],
      audio: false,
      viaChat: false,
      native: "gemini",
      photos: { use: "reference", min: 0, max: 3 },
      pricing: { lines: [], skus: {} },
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** NVIDIA's picture models that answer on its genai endpoints (checked live 2026-10-26: SD 3 and 3.5 are gone). */
const NVIDIA_IMAGES = [
  { id: "black-forest-labs/flux.1-dev", name: "FLUX.1 [dev]" },
  { id: "black-forest-labs/flux.1-schnell", name: "FLUX.1 [schnell]" },
];

const nvidiaModel = (m: { id: string; name: string }): MediaModel => ({
  id: m.id,
  name: m.name,
  kind: "image",
  aspectRatios: ASPECTS,
  resolutions: [],
  durations: [],
  audio: false,
  viaChat: false,
  native: "nvidia",
  photos: null,
  // Drawn on NVIDIA's free developer credits: no money, so no question before each picture.
  pricing: { lines: [{ billable: "output_image", unit: "image", costUsd: 0, variant: null }], skus: {} },
});

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
    const body = (await fetchJson(`${conn.baseUrl}/images/models/${id}/endpoints`, conn.apiKey, 15_000, {}, conn.fetch)) as { endpoints?: { pricing?: unknown }[] };
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

/** Picture models of a custom server's one list of models, told by their names. */
async function namedImageModels(conn: Connection): Promise<MediaModel[]> {
  let items: Raw[] = [];
  try {
    const body = (await fetchJson(`${conn.baseUrl}/models`, conn.apiKey, 15_000, {}, conn.fetch)) as { data?: unknown };
    items = (Array.isArray(body?.data) ? body.data : []).filter((i): i is Raw => !!i && typeof i === "object");
  } catch {
    return [];
  }
  return items
    .filter((i) => typeof i.id === "string" && mediaKindByName(i.id) === "image")
    .map((i): MediaModel => {
      const id = i.id as string;
      const chat = /gemini|nano-banana/i.test(id);
      return {
        id,
        name: typeof i.name === "string" && i.name ? i.name : id,
        kind: "image",
        aspectRatios: [],
        resolutions: [],
        durations: [],
        audio: false,
        viaChat: chat,
        openaiImages: !chat,
        photos: null,
        pricing: { lines: [], skus: {} },
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
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
    // The catalog says how many reference photos a model takes; one that names none takes none.
    const refs = (raw.supported_parameters as Record<string, { min?: unknown; max?: unknown }> | undefined)?.input_references;
    const maxRefs = typeof refs?.max === "number" ? refs.max : 0;
    return {
      id,
      name,
      kind,
      photos: maxRefs > 0 ? { use: "reference", min: typeof refs?.min === "number" ? refs.min : 0, max: maxRefs } : null,
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
    // A clip that can start from a photo says so in its frames.
    photos: strings(raw.supported_frame_images).includes("first_frame") ? { use: "first_frame", min: 0, max: 1 } : null,
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
