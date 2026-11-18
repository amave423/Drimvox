import type { MediaModel } from "@drimvox/shared";
import { randomUUID } from "node:crypto";
import { IMAGE_SIZES } from "../local/images/catalog";
import { describeError, ProviderFailure } from "../providers/errors";
import type { Connection } from "../providers/repo";
import type { Generated } from "./generate";

/**
 * Pictures through a ComfyUI the user runs (asked for: "what about other engines, not only stable-diffusion.cpp").
 * ComfyUI takes new models first and in their own formats (int8_convrot, split files); Drimvox lists what lies in its
 * model folders, offers the models it has a graph for, and draws through its API: a graph to /prompt, its result from
 * /history, the picture from /view. See docs/specs/local-images.md.
 */

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** A model of ComfyUI's that Drimvox can draw with: which graph, and the files it takes. */
interface Recipe {
  kind: "qwen-image-2.1" | "checkpoint";
  diffusion: string;
  encoder?: string;
  vae?: string;
}

const QWEN_21 = /qwen[-_ ]?image[-_ ]?2[._]1/i;

/** The files of one of ComfyUI's model folders; empty when it has none or does not say. */
async function folder(conn: Connection, name: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await conn.fetch(`${conn.baseUrl}/models/${name}`, { signal: signal ?? AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const list = (await res.json()) as unknown;
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

/** The models ComfyUI holds that Drimvox has a graph for, with an id that says how to draw them. */
export async function comfyRecipes(conn: Connection): Promise<Recipe[]> {
  const [diffusion, encoders, vaes, checkpoints] = await Promise.all(["diffusion_models", "text_encoders", "vae", "checkpoints"].map((f) => folder(conn, f)));
  const recipes: Recipe[] = [];
  // Qwen-Image 2.1: its own encoder (Qwen3-VL 8B) and VAE, as ComfyUI's own template has it.
  const encoder = encoders!.find((f) => /qwen3[-_ ]?vl[-_ ]?8b/i.test(f));
  const vae = vaes!.find((f) => /qwen[-_ ]?image[-_ ]?2[._]1[-_ ]?vae/i.test(f));
  if (encoder && vae) for (const f of diffusion!.filter((d) => QWEN_21.test(d))) recipes.push({ kind: "qwen-image-2.1", diffusion: f, encoder, vae });
  // A checkpoint carries its own encoder and VAE.
  for (const f of checkpoints!) recipes.push({ kind: "checkpoint", diffusion: f });
  return recipes;
}

const idOf = (r: Recipe) => `${r.kind}:${r.diffusion}`;

function recipeOf(id: string, all: Recipe[]): Recipe {
  const found = all.find((r) => idOf(r) === id);
  if (!found) throw new ProviderFailure({ code: "model_not_found", detail: `ComfyUI has no ${id.split(":").slice(1).join(":")} now, or its other files are missing` });
  return found;
}

/** ComfyUI's models as the picture chat lists them: free, the sizes Drimvox draws locally. */
export async function comfyMediaModels(conn: Connection, kind: "image" | "video"): Promise<MediaModel[]> {
  if (kind !== "image") return [];
  return (await comfyRecipes(conn)).map((r) => ({
    id: idOf(r),
    name: `${r.diffusion.replace(/\.(safetensors|ckpt|pt|gguf)$/i, "").split(/[\\/]/).pop()}${r.kind === "qwen-image-2.1" ? " · Qwen-Image 2.1" : ""}`,
    kind: "image",
    aspectRatios: Object.keys(IMAGE_SIZES),
    resolutions: [],
    durations: [],
    audio: false,
    viaChat: false,
    photos: null,
    pricing: { lines: [{ billable: "output_image", unit: "image", costUsd: 0, variant: null }], skus: {} },
  }));
}

/** The graph for a recipe, in ComfyUI's API format. */
export function comfyGraph(r: Recipe, prompt: string, width: number, height: number, seed: number): Graph {
  const save = (images: [string, number]): Graph[string] => ({ class_type: "SaveImage", inputs: { images, filename_prefix: "drimvox" } });
  if (r.kind === "qwen-image-2.1") {
    // ComfyUI's template image_qwen_image_2_1_t2i: 25 steps, cfg 1, euler, simple.
    return {
      "1": { class_type: "UNETLoader", inputs: { unet_name: r.diffusion, weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: r.encoder, type: "qwen_image", device: "default" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: r.vae } },
      "4": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["2", 0], prompt, negative_prompt: "", vae: ["3", 0], resolution: 1024 } },
      "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
      "6": {
        class_type: "KSampler",
        inputs: { model: ["1", 0], positive: ["4", 0], negative: ["4", 1], latent_image: ["5", 0], seed, steps: 25, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 },
      },
      "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["3", 0] } },
      "8": save(["7", 0]),
    };
  }
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: r.diffusion } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], seed, steps: 25, cfg: 6, sampler_name: "euler", scheduler: "normal", denoise: 1 },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": save(["6", 0]),
  };
}

/** How long one picture may take: a big model partly in main memory takes minutes. */
const DRAW_MS = 15 * 60_000;

async function call(conn: Connection, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  try {
    return await conn.fetch(`${conn.baseUrl}${path}`, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new ProviderFailure(describeError(err));
  }
}

/** Draws one picture with ComfyUI. Stop interrupts its job. */
export async function drawComfy(conn: Connection, modelId: string, prompt: string, aspectRatio: string | undefined, signal?: AbortSignal): Promise<Generated> {
  const recipe = recipeOf(modelId, await comfyRecipes(conn));
  const [width, height] = IMAGE_SIZES[aspectRatio ?? "1:1"] ?? IMAGE_SIZES["1:1"]!;
  const graph = comfyGraph(recipe, prompt, width, height, Math.floor(Math.random() * 2 ** 31));
  const sent = await call(conn, "/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: graph, client_id: randomUUID() }) }, signal);
  const body = (await sent.json().catch(() => null)) as { prompt_id?: string; error?: { message?: string }; node_errors?: unknown } | null;
  if (!sent.ok || !body?.prompt_id) {
    const why = body?.error?.message ?? `ComfyUI answered ${sent.status}`;
    throw new ProviderFailure({ code: "provider_error", detail: `${why}${body?.node_errors ? ` ${JSON.stringify(body.node_errors).slice(0, 200)}` : ""}` });
  }
  const id = body.prompt_id;
  const stop = () => void conn.fetch(`${conn.baseUrl}/interrupt`, { method: "POST" }).catch(() => {});
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const until = Date.now() + DRAW_MS;
    while (Date.now() < until) {
      if (signal?.aborted) throw new ProviderFailure({ code: "provider_error", detail: "Stopped" });
      const res = await call(conn, `/history/${id}`, {}, signal);
      const history = (await res.json().catch(() => ({}))) as Record<string, { status?: { status_str?: string; messages?: unknown[] }; outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }> }>;
      const entry = history[id];
      if (entry?.status?.status_str === "error") {
        throw new ProviderFailure({ code: "provider_error", detail: `ComfyUI could not draw it: ${JSON.stringify(entry.status.messages ?? []).slice(0, 300)}` });
      }
      const image = Object.values(entry?.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
      if (image) {
        const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
        const file = await call(conn, `/view?${q}`, {}, signal);
        if (!file.ok) throw new ProviderFailure({ code: "provider_error", detail: `ComfyUI did not give the picture (${file.status})` });
        return { bytes: Buffer.from(await file.arrayBuffer()), mime: file.headers.get("content-type")?.split(";")[0] || "image/png", costUsd: 0 };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    stop();
    throw new ProviderFailure({ code: "timeout" });
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
