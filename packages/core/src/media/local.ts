import type { MediaModel } from "@artel/shared";
import { IMAGE_SIZES } from "../local/images/catalog";
import { EngineError } from "../local/images/server";
import type { LocalImages } from "../local/images/service";
import { ProviderFailure } from "../providers/errors";
import type { Generated } from "./generate";

/** The picture engine of this core (docs/specs/local-images.md), set when the core starts. */
let engine: LocalImages | null = null;

export function useLocalImages(images: LocalImages): void {
  engine = images;
}

/** The downloaded picture models, as the picture chats list them: free, every aspect ratio the engine draws. */
export async function localMediaModels(): Promise<MediaModel[]> {
  if (!engine) return [];
  return (await engine.installed()).map((m) => ({
    id: m.id,
    name: m.name,
    kind: "image" as const,
    aspectRatios: Object.keys(IMAGE_SIZES),
    resolutions: [],
    durations: [],
    audio: false,
    viaChat: false,
    pricing: { lines: [{ billable: "output_image", unit: "image", costUsd: 0, variant: null }], skus: {} },
  }));
}

export async function drawLocally(model: string, prompt: string, aspectRatio: string | undefined, signal?: AbortSignal): Promise<Generated> {
  if (!engine) throw new ProviderFailure({ code: "provider_error", detail: "The picture engine is not running" });
  try {
    return { bytes: await engine.draw(model, prompt, aspectRatio, signal), mime: "image/png", costUsd: 0 };
  } catch (err) {
    if (err instanceof EngineError) throw new ProviderFailure({ code: "provider_error", detail: err.message });
    throw err;
  }
}
