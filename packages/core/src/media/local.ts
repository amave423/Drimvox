import type { MediaModel } from "@drimvox/shared";
import { IMAGE_SIZES, VIDEO_DURATIONS, VIDEO_SIZES } from "../local/images/catalog";
import { EngineError } from "../local/images/server";
import type { LocalImages } from "../local/images/service";
import { ProviderFailure } from "../providers/errors";
import type { Generated, Photo } from "./generate";

/** The picture engine of this core (docs/specs/local-images.md), set when the core starts. */
let engine: LocalImages | null = null;

export function useLocalImages(images: LocalImages): void {
  engine = images;
}

/** The downloaded models of one kind, as the picture and video chats list them: free, the sizes the engine makes. */
export async function localMediaModels(kind: "image" | "video"): Promise<MediaModel[]> {
  if (!engine) return [];
  const common = { audio: false, viaChat: false };
  return (await engine.installed())
    .filter((m) => m.kind === kind)
    .map((m): MediaModel =>
      kind === "image"
        ? {
            ...common,
            id: m.id,
            name: m.name,
            kind,
            aspectRatios: Object.keys(IMAGE_SIZES),
            resolutions: [],
            durations: [],
            photos: null,
            pricing: { lines: [{ billable: "output_image", unit: "image", costUsd: 0, variant: null }], skus: {} },
          }
        : {
            ...common,
            id: m.id,
            name: m.name,
            kind,
            aspectRatios: Object.keys(VIDEO_SIZES),
            resolutions: ["480p"],
            durations: VIDEO_DURATIONS,
            // Wan 2.2 5B makes a clip from text or from a picture (TI2V): the photo is its first frame.
            photos: m.family === "wan2.2-ti2v-5b" ? { use: "first_frame", min: 0, max: 1 } : null,
            pricing: { lines: [], skus: { duration_seconds: "0" } },
          },
    );
}

/** A clip on this computer: made right in the answer (minutes), not as a provider's job to wait for. */
export async function filmLocally(model: string, prompt: string, o: { aspectRatio?: string; duration?: number }, signal?: AbortSignal, photo?: Photo): Promise<Generated> {
  if (!engine) throw new ProviderFailure({ code: "provider_error", detail: "The video engine is not running" });
  try {
    const clip = await engine.film(model, prompt, o.aspectRatio, o.duration, signal, photo && `data:${photo.mime};base64,${photo.data.toString("base64")}`);
    return { ...clip, costUsd: 0 };
  } catch (err) {
    if (err instanceof EngineError) throw new ProviderFailure({ code: "provider_error", detail: err.message });
    throw err;
  }
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
