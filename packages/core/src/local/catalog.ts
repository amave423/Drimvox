import type { HfRepo, HfVariant, LocalHardware, LocalPick, LocalUse } from "@artel/shared";
import { fitOf, recommend } from "./fit";

/**
 * Artel's short list from Ollama's catalog, small to large, so that every computer gets something. Sizes are read
 * from Ollama's registry when shown; a tag the registry no longer has is left out. Checked 2026-10-13.
 */
export const PICKS: { model: string; uses: LocalUse[] }[] = [
  { model: "llama3.2:3b", uses: ["chat"] },
  { model: "gemma4:e2b", uses: ["chat", "vision"] },
  { model: "gemma4:e4b", uses: ["chat", "vision", "tools"] },
  { model: "qwen3:8b", uses: ["chat", "tools"] },
  { model: "gemma4:12b", uses: ["chat", "vision", "tools"] },
  { model: "qwen3:14b", uses: ["chat", "code", "tools"] },
  { model: "gpt-oss:20b", uses: ["chat", "code", "tools"] },
  { model: "gemma4:26b", uses: ["chat", "vision", "tools"] },
  { model: "qwen3.6:27b", uses: ["chat", "code", "tools"] },
  { model: "qwen3.8:27b", uses: ["chat", "code", "tools"] },
  { model: "qwen3-coder:30b", uses: ["code", "tools"] },
  { model: "qwen3.6:35b", uses: ["chat", "code", "tools"] },
];

/** The interface text key of a pick: gemma4:e4b → gemma4-e4b. */
export const familyOf = (model: string) => model.replace(":", "-");

/** A file of a repository, as Hugging Face lists it. */
export interface HfFile {
  type: string;
  path: string;
  size: number;
}

/** The quantization at the end of a GGUF file name: Q4_K_M, UD-Q5_K_XL, IQ3_XXS, BF16… */
const QUANT = /((?:UD-)?(?:I?Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32))$/i;

/**
 * The variants of a repository Ollama can pull as hf.co/<repo>:<quant>, smallest first, with what runs here.
 * Multi-part files, vision projectors (mmproj) and importance matrices are not models to pull.
 */
export function variantsOf(repo: string, files: HfFile[], hw: LocalHardware, installed: string[]): HfVariant[] {
  const variants = files.flatMap((f) => {
    if (f.type !== "file" || !/\.gguf$/i.test(f.path) || f.path.includes("/")) return [];
    if (/mmproj|imatrix|-\d{5}-of-\d{5}/i.test(f.path)) return [];
    const quant = f.path.replace(/\.gguf$/i, "").match(QUANT)?.[1];
    const fit = quant ? fitOf(f.size, hw) : null;
    if (!quant || !fit) return [];
    const model = `hf.co/${repo}:${quant}`;
    return [{ quant, file: f.path, sizeBytes: f.size, fit, recommended: false, model, installed: installed.some((m) => sameModel(m, model)) }];
  });
  variants.sort((a, b) => a.sizeBytes - b.sizeBytes);
  const best = recommend(variants);
  if (best) best.recommended = true;
  return variants;
}

/** Ollama lists hf.co models in lower case and adds :latest to names without a tag. */
export function sameModel(a: string, b: string): boolean {
  const norm = (m: string) => (m.includes(":") ? m : `${m}:latest`).toLowerCase();
  return norm(a) === norm(b);
}

/** Even the most squeezed variant takes about this many bytes per parameter. */
const SMALLEST_BYTES_PER_PARAM = 0.42;

export interface CatalogOptions {
  registryUrl: string;
  hfUrl: string;
  fetch?: typeof fetch;
}

export class CatalogError extends Error {}

/** Ollama's registry and Hugging Face, sized for this computer. */
export class LocalCatalog {
  private readonly sizes = new Map<string, { at: number; bytes: number | null }>();
  constructor(private readonly o: CatalogOptions) {}

  private get(url: string): Promise<Response> {
    return (this.o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  }

  /** A tag's download size from the registry; null when the registry does not know it. Kept for a day. */
  private async sizeOf(model: string): Promise<number | null> {
    const known = this.sizes.get(model);
    if (known && Date.now() - known.at < 24 * 3600_000) return known.bytes;
    const [name, tag = "latest"] = model.split(":");
    const path = name!.includes("/") ? name : `library/${name}`;
    let bytes: number | null = null;
    try {
      const res = await this.get(`${this.o.registryUrl}/v2/${path}/manifests/${tag}`);
      if (res.ok) {
        const manifest = (await res.json()) as { layers?: { size?: number }[] };
        bytes = (manifest.layers ?? []).reduce((sum, l) => sum + (l.size ?? 0), 0) || null;
      } else if (res.status !== 404) return null;
    } catch {
      return null;
    }
    this.sizes.set(model, { at: Date.now(), bytes });
    return bytes;
  }

  /** The short list, without what this computer cannot run or the registry does not have. */
  async picks(hw: LocalHardware, installed: string[]): Promise<LocalPick[]> {
    const sized = await Promise.all(PICKS.map(async (p) => ({ ...p, sizeBytes: await this.sizeOf(p.model) })));
    return sized.flatMap((p) => {
      const fit = p.sizeBytes ? fitOf(p.sizeBytes, hw) : null;
      if (!p.sizeBytes || !fit) return [];
      return [{ model: p.model, family: familyOf(p.model), uses: p.uses, sizeBytes: p.sizeBytes, fit, installed: installed.some((m) => sameModel(m, p.model)) }];
    });
  }

  /** GGUF repositories on Hugging Face, most downloaded first; those too big for this computer are left out. */
  async search(query: string, hw: LocalHardware): Promise<HfRepo[]> {
    const q = new URLSearchParams({ search: query, filter: "gguf", sort: "downloads", limit: "30" });
    for (const field of ["gguf", "downloads", "likes", "lastModified"]) q.append("expand[]", field);
    let res: Response;
    try {
      res = await this.get(`${this.o.hfUrl}/api/models?${q}`);
    } catch (err) {
      throw new CatalogError(`Hugging Face did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new CatalogError(`Hugging Face answered ${res.status}`);
    const items = (await res.json()) as { id: string; downloads?: number; likes?: number; lastModified?: string; gguf?: { total?: number } }[];
    return items.flatMap((m) => {
      const params = typeof m.gguf?.total === "number" ? m.gguf.total : null;
      if (params && !fitOf(params * SMALLEST_BYTES_PER_PARAM, hw)) return [];
      return [{ repo: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0, params, updatedAt: m.lastModified ?? null }];
    });
  }

  /** A repository's variants that run here, with the advice. */
  async variants(repo: string, hw: LocalHardware, installed: string[]): Promise<HfVariant[]> {
    let res: Response;
    try {
      res = await this.get(`${this.o.hfUrl}/api/models/${repo}/tree/main`);
    } catch (err) {
      throw new CatalogError(`Hugging Face did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new CatalogError(`Hugging Face answered ${res.status}`);
    return variantsOf(repo, (await res.json()) as HfFile[], hw, installed);
  }
}
