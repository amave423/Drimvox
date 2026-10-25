import type { HfMediaFile, HfMediaRepo, LocalHardware } from "@drimvox/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fitOf, recommend } from "../fit";
import { familyOf, foundModel, IMAGE_MODELS, isComponent, quantOf, sizeOf, type ImageModelDef } from "./catalog";

/** What Hugging Face calls each kind of model in its search. */
const TASK = { image: "text-to-image", video: "text-to-video" } as const;

/** A failure of Hugging Face itself: the page says it could not be reached. */
export class HubError extends Error {}

/** The models found on Hugging Face and downloaded, kept in the images' folder (docs/specs/local-images.md). */
export class FoundModels {
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, "found.json");
  }

  list(): ImageModelDef[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { repo: string; path: string; bytes: number }[];
      return raw.flatMap((f) => {
        const family = IMAGE_MODELS.find((m) => m.id === familyOf(`${f.repo}/${f.path}`));
        return family ? [foundModel(family, f.repo, f.path, f.bytes)] : [];
      });
    } catch {
      return [];
    }
  }

  add(def: ImageModelDef): void {
    this.save([...this.list().filter((m) => m.id !== def.id), def]);
  }

  remove(id: string): void {
    this.save(this.list().filter((m) => m.id !== id));
  }

  /** Only each model's own file is kept: its family gives the rest. */
  private save(models: ImageModelDef[]): void {
    const own = models.map((m) => m.variants[0]!.find((f) => f.role === "diffusion")!);
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(own.map(({ repo, path, bytes }) => ({ repo, path, bytes })), null, 2));
  }
}

export async function hub(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch((err: unknown) => {
    throw new HubError(`Hugging Face did not answer: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!res.ok) throw new HubError(`Hugging Face answered ${res.status}`);
  return res.json();
}

/** Repositories of models that make pictures or clips, by downloads; the ones Drimvox can run first. */
export async function searchMedia(apiUrl: string, kind: "image" | "video", query: string): Promise<HfMediaRepo[]> {
  const params = new URLSearchParams({ search: query, pipeline_tag: TASK[kind], sort: "downloads", direction: "-1", limit: "40" });
  const list = (await hub(`${apiUrl}/api/models?${params}`)) as { id?: unknown; downloads?: unknown; likes?: unknown }[];
  const repos = (Array.isArray(list) ? list : []).flatMap((r) =>
    typeof r.id === "string" ? [{ repo: r.id, downloads: Number(r.downloads) || 0, likes: Number(r.likes) || 0, family: familyOf(r.id) }] : [],
  );
  // A family of the other kind (a video model found as a picture one) cannot be run as this kind.
  const fits = (r: HfMediaRepo) => r.family !== null && IMAGE_MODELS.find((m) => m.id === r.family)!.kind === kind;
  return [...repos.filter(fits), ...repos.filter((r) => !fits(r)).map((r) => ({ ...r, family: null }))];
}

/** The model files of a repository, each with its family's other files counted in the size and the fit. */
export async function mediaFiles(apiUrl: string, repo: string, hw: LocalHardware, installed: (id: string) => boolean): Promise<HfMediaFile[]> {
  const tree = (await hub(`${apiUrl}/api/models/${repo}/tree/main?recursive=true`)) as { type: string; path: string; size: number; lfs?: { size?: number } }[];
  const files = (Array.isArray(tree) ? tree : []).filter((f) => f.type === "file" && /\.(gguf|safetensors)$/i.test(f.path) && !isComponent(f.path));
  const list = files.flatMap((f) => {
    const family = IMAGE_MODELS.find((m) => m.id === familyOf(`${repo}/${f.path}`));
    if (!family) return [];
    const def = foundModel(family, repo, f.path, f.lfs?.size ?? f.size);
    const sizeBytes = sizeOf(def.variants[0]!);
    return [{ model: def.id, file: f.path, quant: quantOf(f.path), sizeBytes, fit: fitOf(sizeBytes, hw), recommended: false, installed: installed(def.id) }];
  });
  const runs = list.filter((f): f is HfMediaFile & { fit: "fast" | "slow" } => f.fit !== null);
  const best = recommend(runs.map((f) => ({ ...f, quant: f.quant ?? "F16" })));
  return list.map((f) => ({ ...f, recommended: !!best && best.model === f.model })).sort((a, b) => a.file.localeCompare(b.file));
}
