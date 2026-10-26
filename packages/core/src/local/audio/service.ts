import type { HfAudioFile, HfAudioRepo, LocalAudioStatus, LocalPull } from "@drimvox/shared";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fetchVia } from "../../proxy";
import { downloadFile, fileByPath, type Route } from "../hf-download";
import { AUDIO_MODELS, type AudioModelDef } from "./catalog";
import { audioFiles, FoundAudio, foundAudio, parseFound, searchAudio } from "./found";
import { findCli, installWhisper, whisperUrl } from "./engine";

export interface LocalAudioOptions {
  /** The engine's archive; Drimvox's pinned build for this system by default, null where there is none. */
  engineUrl?: string | null;
  /** Tests: what runs instead of the downloaded whisper-cli. */
  cliCommand?: string[];
}

interface Deps {
  /** The audio folder: the engine and the models. */
  dir: string;
  hf: { apiUrl: string; bases: string[]; dir: string; proxy(): string | null };
  connect(): string;
  providerId(): string | null;
}

interface Active {
  pull: LocalPull;
  abort: AbortController;
  partial?: string;
}

/** A recording longer than this is not written down in one go. */
const TRANSCRIBE_MS = 5 * 60_000;

/**
 * Speech on this computer (docs/specs/local-audio.md): whisper.cpp and its models, downloaded by Drimvox; dictation is
 * written down by running whisper-cli on the recording, free and without the internet.
 */
export class LocalAudio {
  private readonly pulls = new Map<string, Active>();
  private readonly url: string | null;
  private readonly found: FoundAudio;

  constructor(
    private readonly d: Deps,
    private readonly o: LocalAudioOptions = {},
  ) {
    this.url = o.engineUrl === undefined ? whisperUrl() : o.engineUrl;
    this.found = new FoundAudio(d.dir);
  }

  /** Drimvox's own models and the ones downloaded from a search. */
  private defs(): AudioModelDef[] {
    return [...AUDIO_MODELS, ...this.found.list()];
  }

  /** Speech models on Hugging Face, the ones whisper.cpp runs first. */
  search(query: string): Promise<HfAudioRepo[]> {
    return searchAudio(this.d.hf.apiUrl, query);
  }

  /** A found repository's whisper.cpp files. */
  files(repo: string): Promise<HfAudioFile[]> {
    return audioFiles(this.d.hf.apiUrl, repo, (id) => this.installed().some((m) => m.id === id));
  }

  private get engineDir() {
    return join(this.d.dir, "engine");
  }

  private pathOf(m: AudioModelDef) {
    return join(this.d.dir, "models", m.file);
  }

  status(): LocalAudioStatus {
    return {
      supported: this.url !== null,
      engine: !!findCli(this.engineDir),
      providerId: this.d.providerId(),
      models: this.defs().map((m) => ({
        id: m.id,
        name: m.name,
        note: m.note,
        source: m.id.startsWith("hf:") ? ("hf" as const) : ("checked" as const),
        sizeBytes: m.bytes,
        installed: existsSync(this.pathOf(m)),
        pull: this.pulls.get(m.id)?.pull ?? null,
      })),
    };
  }

  /** The downloaded models: what the engine's provider lists. */
  installed(): AudioModelDef[] {
    return this.defs().filter((m) => existsSync(this.pathOf(m)));
  }

  /** Starts downloading a model (and the engine, the first time); a found one is looked up on Hugging Face first. */
  async pull(id: string): Promise<LocalPull> {
    if (this.url === null) throw new Error("There is no build of the engine for this system");
    let model = this.defs().find((m) => m.id === id);
    const where = parseFound(id);
    if (!model && where) {
      const info = await fileByPath(this.d.hf.apiUrl, where.repo, where.path, AbortSignal.timeout(30_000));
      model = foundAudio(where.repo, where.path, info.size);
      this.found.add(model);
    }
    if (!model) throw new Error("Unknown speech model");
    const going = this.pulls.get(id);
    if (going && !going.pull.done && !going.pull.paused) return { ...going.pull };
    const a: Active = {
      pull: { model: id, status: "starting", completed: going?.pull.completed ?? 0, total: model.bytes, done: false, error: null, paused: false, bytesPerSecond: null },
      abort: new AbortController(),
    };
    this.pulls.set(id, a);
    void this.download(a, model);
    return { ...a.pull };
  }

  private routes(): Route[] {
    const proxy = this.d.hf.proxy();
    return [{ label: "direct", fetch }, ...(proxy ? [{ label: "proxy", fetch: fetchVia(proxy) }] : [])];
  }

  private async download(a: Active, model: AudioModelDef): Promise<void> {
    const p = a.pull;
    const signal = a.abort.signal;
    let sample = { at: Date.now(), completed: p.completed };
    const measure = () => {
      const seconds = (Date.now() - sample.at) / 1000;
      if (seconds < 0.5) return;
      const rate = Math.max(0, (p.completed - sample.completed) / seconds);
      p.bytesPerSecond = p.bytesPerSecond === null ? rate : p.bytesPerSecond * 0.6 + rate * 0.4;
      sample = { at: Date.now(), completed: p.completed };
    };
    try {
      p.status = "pulling manifest";
      const info = existsSync(this.pathOf(model)) ? null : await fileByPath(this.d.hf.apiUrl, model.repo, model.path, signal);
      let engine = { got: 0, of: 0 };
      const recount = (inFile: number) => {
        p.completed = engine.got + inFile;
        p.total = engine.of + (info?.size ?? 0);
        measure();
      };
      if (!findCli(this.engineDir)) {
        p.status = "downloading the engine";
        await installWhisper({
          url: this.url!,
          dir: this.engineDir,
          fetch: this.routes()[0]!.fetch,
          signal,
          progress: (received, total) => {
            engine = { got: received, of: Math.max(total, received) };
            recount(0);
          },
        });
      }
      if (info) {
        p.status = "downloading";
        const part = await downloadFile(
          {
            apiUrl: this.d.hf.apiUrl,
            bases: this.d.hf.bases,
            routes: this.routes(),
            dir: this.d.hf.dir,
            signal,
            partial: (path) => (a.partial = path),
            progress: (s) => (s.status === "downloading" ? recount(s.completed) : (p.status = s.status)),
          },
          model.repo,
          info,
        );
        if (!part) return;
        mkdirSync(join(this.d.dir, "models"), { recursive: true });
        renameSync(part, this.pathOf(model));
        a.partial = undefined;
      }
      Object.assign(p, { done: true, error: null, status: "success", completed: p.total, bytesPerSecond: null });
      this.d.connect();
    } catch (err) {
      if (signal.aborted) return;
      Object.assign(p, { done: true, error: err instanceof Error ? err.message : String(err), bytesPerSecond: null });
    }
  }

  pause(id: string): boolean {
    const a = this.pulls.get(id);
    if (!a || a.pull.done) return false;
    a.abort.abort();
    Object.assign(a.pull, { paused: true, bytesPerSecond: null, status: "paused" });
    return true;
  }

  cancel(id: string): boolean {
    const a = this.pulls.get(id);
    if (!a) return false;
    a.abort.abort();
    this.pulls.delete(id);
    // A found model not downloaded after all leaves the list.
    const def = this.defs().find((m) => m.id === id);
    if (def && id.startsWith("hf:") && !existsSync(this.pathOf(def))) this.found.remove(id);
    const file = a.partial;
    if (file) setTimeout(() => rmSync(file, { force: true }), 500).unref();
    return true;
  }

  remove(id: string): boolean {
    const model = this.defs().find((m) => m.id === id);
    if (!model || !existsSync(this.pathOf(model))) return false;
    rmSync(this.pathOf(model), { force: true });
    this.pulls.delete(id);
    if (id.startsWith("hf:")) this.found.remove(id);
    return true;
  }

  /** Deletes the engine, the models staying; refused while something downloads. */
  removeEngine(): boolean {
    if ([...this.pulls.values()].some((a) => !a.pull.done && !a.pull.paused)) return false;
    rmSync(this.engineDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    for (const [id, a] of this.pulls) if (a.pull.done) this.pulls.delete(id);
    return true;
  }

  /** A WAV recording written down by the model, in the language it is spoken in. */
  async transcribe(id: string, wav: Buffer): Promise<string> {
    const model = this.installed().find((m) => m.id === id);
    if (!model) throw new Error("This speech model is not downloaded");
    const found = findCli(this.engineDir);
    const cli = this.o.cliCommand ?? [found ?? ""];
    if (!cli[0]) throw new Error("The speech engine is not downloaded");
    const file = join(this.d.dir, `dictation-${Date.now()}.wav`);
    writeFileSync(file, wav);
    // The engine runs in its own folder with paths relative to it: a full path with letters outside ASCII (a Windows
    // user named in Cyrillic) broke Piper, and these engines read their files the same way.
    const cwd = found ? dirname(found) : this.d.dir;
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile(
          cli[0]!,
          [...cli.slice(1), "-m", relative(cwd, this.pathOf(model)), "-f", relative(cwd, file), "-l", "auto", "-nt", "-np"],
          { cwd, timeout: TRANSCRIBE_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
        ),
      );
      return out.replace(/\s+/g, " ").trim();
    } finally {
      rmSync(file, { force: true });
    }
  }
}

let current: LocalAudio | null = null;
/** The app's speech engine, for the providers' list and dictation. */
export function useLocalAudio(audio: LocalAudio): void {
  current = audio;
}
export function localAudio(): LocalAudio | null {
  return current;
}
