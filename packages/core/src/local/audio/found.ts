import type { HfAudioFile, HfAudioRepo } from "@drimvox/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { hub } from "../images/found";
import { AUDIO_MODELS, type AudioModelDef } from "./catalog";

/** whisper.cpp's files: ggml's .bin, not the Core ML encoders that come beside them. */
const isGgml = (path: string) => /\.bin$/i.test(path) && /ggml/i.test(basename(path)) && !/encoder/i.test(path);

/** A file found on Hugging Face, as a model: named by its file, kept under a name that tells repositories apart. */
export function foundAudio(repo: string, path: string, bytes: number): AudioModelDef {
  const name = basename(path).replace(/\.bin$/i, "").replace(/^ggml-?/i, "");
  return { id: `hf:${repo}:${path}`, name: `${name} · ${repo.split("/")[0]}`, note: null, repo, path, file: `${repo.replace("/", "--")}--${basename(path)}`, bytes };
}

export function parseFound(id: string): { repo: string; path: string } | null {
  const m = /^hf:([^:]+):(.+)$/.exec(id);
  return m ? { repo: m[1]!, path: m[2]! } : null;
}

/** The speech models found on Hugging Face and downloaded, kept in the audio folder. */
export class FoundAudio {
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, "found.json");
  }

  list(): AudioModelDef[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { repo: string; path: string; bytes: number }[];
      return raw.map((f) => foundAudio(f.repo, f.path, f.bytes));
    } catch {
      return [];
    }
  }

  add(def: AudioModelDef): void {
    this.save([...this.list().filter((m) => m.id !== def.id), def]);
  }

  remove(id: string): void {
    this.save(this.list().filter((m) => m.id !== id));
  }

  private save(models: AudioModelDef[]): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(models.map((m) => ({ repo: m.repo, path: m.path, bytes: m.bytes }))));
  }
}

/**
 * Speech recognition models on Hugging Face, by downloads (asked for: the audio tab had no search). The ones with
 * whisper.cpp's files come first; the rest are shown greyed, since whisper.cpp cannot run them.
 */
export async function searchAudio(apiUrl: string, query: string): Promise<HfAudioRepo[]> {
  const params = new URLSearchParams({ search: query, pipeline_tag: "automatic-speech-recognition", sort: "downloads", direction: "-1", limit: "40" });
  const list = (await hub(`${apiUrl}/api/models?${params}`)) as { id?: unknown; downloads?: unknown; tags?: unknown }[];
  const repos = (Array.isArray(list) ? list : []).flatMap((r) => {
    if (typeof r.id !== "string") return [];
    const tags = Array.isArray(r.tags) ? r.tags.join(" ") : "";
    return [{ repo: r.id, downloads: Number(r.downloads) || 0, runnable: /ggml|whisper[.-]?cpp/i.test(`${r.id} ${tags}`) }];
  });
  return [...repos.filter((r) => r.runnable), ...repos.filter((r) => !r.runnable)];
}

/** A repository's whisper.cpp files, smallest first. */
export async function audioFiles(apiUrl: string, repo: string, installed: (id: string) => boolean): Promise<HfAudioFile[]> {
  const tree = (await hub(`${apiUrl}/api/models/${repo}/tree/main?recursive=true`)) as { type: string; path: string; size: number; lfs?: { size?: number } }[];
  return (Array.isArray(tree) ? tree : [])
    .filter((f) => f.type === "file" && isGgml(f.path))
    .map((f) => {
      // One of Drimvox's own models keeps its own id, so it is not downloaded twice.
      const own = AUDIO_MODELS.find((m) => m.repo === repo && m.path === f.path);
      const def = own ?? foundAudio(repo, f.path, f.lfs?.size ?? f.size);
      return { model: def.id, file: f.path, sizeBytes: f.lfs?.size ?? f.size, installed: installed(def.id) };
    })
    .sort((a, b) => a.sizeBytes - b.sizeBytes);
}
