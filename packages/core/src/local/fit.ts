import type { LocalFit, LocalHardware } from "@artel/shared";

export const GB = 2 ** 30;

/** Memory a model takes beyond its file: the context window and Ollama's own buffers. */
const OVERHEAD = 1 * GB;
/** What is left of main memory for a model next to the system and the apps. */
const RAM_SHARE = 0.75;
/** Apple Silicon gives the video card about this much of the shared memory. */
const UNIFIED_SHARE = 0.7;

/**
 * Whether a model of this size runs here: "fast" in video memory, "slow" only with main memory (part of it on the
 * processor), null when it does not fit at all. See docs/specs/local-models.md.
 */
export function fitOf(sizeBytes: number, hw: LocalHardware): LocalFit | null {
  const need = sizeBytes * 1.15 + OVERHEAD;
  const vram = hw.unified ? hw.ramBytes * UNIFIED_SHARE : (hw.gpu?.vramBytes ?? 0);
  const ram = hw.unified ? 0 : hw.ramBytes * RAM_SHARE;
  if (vram > 0 && need <= vram * 0.95) return "fast";
  if (need <= vram + ram) return "slow";
  return null;
}

/**
 * How good a quantization is: about its bits per weight. Unsloth's dynamic variants (UD-…) rank as their base;
 * K_XL and K_L keep more than K_M, which keeps more than K_S; IQ variants of the same bits keep a little less.
 */
export function quantRank(quant: string): number {
  const q = quant.toUpperCase().replace(/^UD-/, "");
  if (q === "F32") return 32;
  if (q === "F16" || q === "BF16") return 16;
  const m = q.match(/^(I?)Q(\d+)(.*)$/);
  if (!m) return 0;
  const tail = m[3]!;
  const extra = /_K_XL|_K_L/.test(tail) ? 0.4 : /_K_M/.test(tail) ? 0.3 : /_K_S/.test(tail) ? 0.1 : /_K/.test(tail) ? 0.2 : 0.05;
  return Number(m[2]) + extra - (m[1] ? 0.2 : 0);
}

/** The highest quality that never needs more than this: beyond Q8 a model is slower and hardly better. */
const BEST_WORTH = 8.5;
/** Four bits (IQ4_XS included): below it a model loses noticeably; slow and good beats fast and squeezed. */
const GOOD = 3.8;
/** Three bits: the least worth running when nothing four-bit runs at all. */
const FAIR = 3;

/**
 * The advised variant: the best fast one of four bits or more (Q8 at most); else the smallest four-bit one, even if
 * slow; else the best fast one of three bits or more; else the smallest that runs.
 */
export function recommend<T extends { quant: string; sizeBytes: number; fit: LocalFit }>(variants: T[]): T | null {
  const rank = (v: T) => quantRank(v.quant);
  const best = (list: T[]) => (list.length ? list.reduce((a, b) => (rank(b) > rank(a) ? b : a)) : null);
  const smallest = (list: T[]) => (list.length ? list.reduce((a, b) => (b.sizeBytes < a.sizeBytes ? b : a)) : null);
  const worth = variants.filter((v) => rank(v) <= BEST_WORTH);
  return (
    best(worth.filter((v) => v.fit === "fast" && rank(v) >= GOOD)) ??
    smallest(worth.filter((v) => rank(v) >= GOOD)) ??
    best(worth.filter((v) => v.fit === "fast" && rank(v) >= FAIR)) ??
    smallest(variants)
  );
}
