import type { LocalFit, LocalHardware } from "@drimvox/shared";
import { GB } from "./fit";

/**
 * The context window of local models (asked for: "Ollama can put part of a model into main memory, make it Drimvox's
 * own"). Ollama already does that by itself when a model and its window do not fit the video card: it keeps some layers
 * on the processor, slower. What Drimvox chooses is the window, and it keeps the window's cache small (q8_0 with flash
 * attention, half of f16), so more of it fits the card. See docs/specs/local-models.md.
 */
export const LOCAL_WINDOWS = [16_384, 32_768, 65_536, 131_072] as const;

/** One byte per value in the q8_0 cache, and a little for its scales. */
const Q8_BYTES = 34 / 32;
/** Ollama's buffers beside the model and its cache. */
const BUFFERS = 0.6 * GB;
/** What is left of main memory for a model next to the system and the apps. */
const RAM_SHARE = 0.75;
const UNIFIED_SHARE = 0.7;

/**
 * Bytes the window's cache takes per token, from what Ollama says of the model (/api/show model_info); null when it does
 * not say enough. Hybrid models (Qwen 3.5: attention in every fourth layer, the rest a fixed-size state) keep a cache
 * only in their attention layers.
 */
export function kvBytesPerToken(info: Record<string, unknown>): number | null {
  const arch = info["general.architecture"];
  if (typeof arch !== "string") return null;
  const num = (key: string) => (typeof info[`${arch}.${key}`] === "number" ? (info[`${arch}.${key}`] as number) : null);
  const layers = num("block_count");
  const heads = num("attention.head_count");
  const kvHeads = num("attention.head_count_kv") ?? heads;
  const embedding = num("embedding_length");
  const keyLength = num("attention.key_length") ?? (embedding && heads ? embedding / heads : null);
  const valueLength = num("attention.value_length") ?? keyLength;
  if (!layers || !kvHeads || !keyLength || !valueLength) return null;
  const interval = num("full_attention_interval");
  const attentionLayers = interval && interval > 1 ? Math.ceil(layers / interval) : layers;
  return Math.round(attentionLayers * kvHeads * (keyLength + valueLength) * Q8_BYTES);
}

/** Memory a model with this window takes: its file, the window's cache and Ollama's buffers. */
export function windowBytes(modelBytes: number, perToken: number, tokens: number): number {
  return modelBytes * 1.05 + perToken * tokens + BUFFERS;
}

/** "fast": all of it in the video card; "slow": part of it in main memory, on the processor; null: it does not fit. */
export function windowFit(modelBytes: number, perToken: number, tokens: number, hw: LocalHardware): LocalFit | null {
  const need = windowBytes(modelBytes, perToken, tokens);
  const vram = hw.unified ? hw.ramBytes * UNIFIED_SHARE : (hw.gpu?.vramBytes ?? 0);
  const ram = hw.unified ? 0 : hw.ramBytes * RAM_SHARE;
  if (vram > 0 && need <= vram * 0.95) return "fast";
  if (need <= vram + ram) return "slow";
  return null;
}

/**
 * The window to give Ollama when the user left it to Drimvox: the largest that keeps the largest downloaded model in
 * the video card; without models known, 32 thousand from 24 GB of video memory and 16 thousand below.
 */
export function autoWindow(hw: LocalHardware, models: { sizeBytes: number; perToken: number | null }[]): number {
  const known = models.filter((m): m is { sizeBytes: number; perToken: number } => m.perToken !== null);
  if (!known.length) {
    const vram = hw.unified ? hw.ramBytes * UNIFIED_SHARE : (hw.gpu?.vramBytes ?? 0);
    return vram >= 24 * GB ? 32_768 : 16_384;
  }
  const largest = known.reduce((a, b) => (b.sizeBytes > a.sizeBytes ? b : a));
  const fits = LOCAL_WINDOWS.filter((w) => windowFit(largest.sizeBytes, largest.perToken, w, hw) === "fast");
  return fits.at(-1) ?? LOCAL_WINDOWS[0];
}
