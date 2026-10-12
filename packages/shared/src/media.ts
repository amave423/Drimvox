import { z } from "zod";

export type MediaKind = "image" | "video";

/** One billing line of an image endpoint, as OpenRouter publishes it. */
export interface PriceLine {
  billable: string;
  unit: string;
  costUsd: number;
  variant: string | null;
}

export interface MediaModel {
  id: string;
  name: string;
  kind: MediaKind;
  aspectRatios: string[];
  resolutions: string[];
  /** Video only: seconds the model accepts. */
  durations: number[];
  /** Video only: the model can add sound. */
  audio: boolean;
  /** Null until loaded: image prices live on a separate endpoint per model. */
  pricing: { lines: PriceLine[]; skus: Record<string, string> } | null;
}

export const mediaOptionsSchema = z
  .object({
    aspectRatio: z.string().max(20).optional(),
    resolution: z.string().max(20).optional(),
    duration: z.number().int().min(1).max(60).optional(),
    audio: z.boolean().optional(),
  })
  .strict();
export type MediaOptions = z.infer<typeof mediaOptionsSchema>;

/** Generations above this need a press of "Start" with the price on it. */
export const CONFIRM_ABOVE_USD = 0.1;

export function needsConfirmation(model: MediaModel, estimate: number | null): boolean {
  return model.kind === "video" || estimate === null || estimate > CONFIRM_ABOVE_USD;
}

/** Side of a square picture for each resolution name. */
const IMAGE_SIDE: Record<string, number> = { "512": 512, "768": 768, "1k": 1024, "1.5k": 1536, "2k": 2048, "4k": 4096 };
/** Rough output tokens of a 1K picture; token-priced models are estimates only. */
const TOKENS_PER_1K_IMAGE = 1300;
const FRAME: Record<string, [number, number]> = {
  "480p": [854, 480],
  "720p": [1280, 720],
  "768p": [1366, 768],
  "1080p": [1920, 1080],
  "2k": [2560, 1440],
  "4k": [3840, 2160],
};

/** USD a generation will likely cost, or null when the published price cannot be read. */
export function estimateCost(model: MediaModel, o: MediaOptions): number | null {
  if (!model.pricing) return null;
  const value = model.kind === "image" ? imageCost(model.pricing.lines, o) : videoCost(model, model.pricing.skus, o);
  return value === null ? null : Number(value.toFixed(6));
}

function imageCost(lines: PriceLine[], o: MediaOptions): number | null {
  const out = lines.filter((l) => l.billable === "output_image");
  if (out.length === 0) return null;
  const res = (o.resolution ?? "1K").toLowerCase();
  const side = IMAGE_SIDE[res] ?? 1024;
  const priced = (l: PriceLine) =>
    l.unit === "megapixel" ? l.costUsd * ((side * side) / 1_000_000) : l.unit === "token" ? l.costUsd * TOKENS_PER_1K_IMAGE * (side / 1024) ** 2 : l.costUsd;

  const forRes = out.filter((l) => l.variant !== null && (l.variant.toLowerCase() === res || l.variant.toLowerCase().endsWith(`_${res}`)));
  const base = out.filter((l) => l.variant === null);
  // The dearest matching line: quality variants differ in price and the estimate should not undershoot.
  const pool = forRes.length ? forRes : base.length ? base : out;
  return Math.max(...pool.map(priced));
}

interface Sku {
  perSecond: number | null;
  perToken: number | null;
  res: string | null;
  audio: boolean | null;
}

const SKIPPED = /image_to_video|reference|image_input|video_input|continuation|megapixel|upscale|minimum/;

function readSkus(skus: Record<string, string>): { list: Sku[]; minimum: number } {
  const list: Sku[] = [];
  let minimum = 0;
  for (const [rawKey, rawValue] of Object.entries(skus)) {
    let key = rawKey;
    let value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    if (key.startsWith("cents_per_") || key.startsWith("minimum_cents")) value /= 100;
    if (key.startsWith("minimum_") && key.includes("generation")) {
      minimum = value;
      continue;
    }
    if (SKIPPED.test(key)) continue;
    key = key.replace(/^cents_per_/, "").replace(/^text_to_video_/, "");
    const res = key.match(/_(\d+p|\d(?:\.\d)?k)$/)?.[1] ?? null;
    const audio = key.includes("without_audio") ? false : key.includes("with_audio") ? true : null;
    if (key.startsWith("video_tokens")) list.push({ perSecond: null, perToken: value, res, audio });
    else if (key.includes("second")) list.push({ perSecond: value, perToken: null, res, audio });
  }
  return { list, minimum };
}

function videoCost(model: MediaModel, skus: Record<string, string>, o: MediaOptions): number | null {
  const { list, minimum } = readSkus(skus);
  if (list.length === 0) return null;
  const duration = o.duration ?? (model.durations.length ? Math.min(...model.durations) : 5);
  const res = (o.resolution ?? model.resolutions[0] ?? "720p").toLowerCase();
  const audio = model.audio ? (o.audio ?? false) : false;

  // The most specific line wins: exact resolution and sound, then either one, then the plain price.
  const score = (s: Sku) =>
    (s.res === res ? 2 : s.res === null ? 0 : -10) + (s.audio === audio ? 1 : s.audio === null ? 0 : -10);
  const best = [...list].sort((a, b) => score(b) - score(a))[0]!;
  if (score(best) < 0) return null;

  const [w, h] = FRAME[res] ?? FRAME["720p"]!;
  const cost = best.perSecond !== null ? best.perSecond * duration : best.perToken! * ((w * h * 24 * duration) / 1024);
  return Math.max(cost, minimum);
}

/** A picture or a clip Artel keeps: made in a chat or by an agent. */
export interface MediaItem {
  id: string;
  kind: MediaKind;
  mime: string;
  prompt: string;
  providerId: string | null;
  model: string;
  /** USD from the provider's answer; null when it did not say. */
  costUsd: number | null;
  chatId: string | null;
  taskId: string | null;
  /** For an agent's picture: where it lies in the project. */
  path: string | null;
  createdAt: number;
}
