import type { LocalHardware, LocalImageModelId, LocalImagesStatus, LocalPull } from "@artel/shared";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fetchVia } from "../../proxy";
import { downloadFile, fileByPath, type Route } from "../hf-download";
import { fileKey, IMAGE_MODELS, IMAGE_SIZES, sizeOf, variantFor, type ImageFile, type ImageFileRole, type ImageModelDef } from "./catalog";
import { ENGINE_TAG, engineUrl, findServer, installEngine } from "./engine";
import { EngineError, ImageServer } from "./server";

export interface LocalImagesOptions {
  /** The engine's archive; Artel's pinned build for this system by default, null where there is none. */
  engineUrl?: string | null;
  /** Tests: what runs instead of the downloaded server (its options follow). */
  serverCommand?: string[];
  serverEnv?: Record<string, string>;
  /** Default 10 minutes. */
  idleMs?: number;
}

interface Deps {
  /** The images' folder: the engine and the models' files. */
  dir: string;
  hardware(): Promise<LocalHardware>;
  hf: { apiUrl: string; bases: string[]; dir: string; proxy(): string | null };
  /** The provider the picture chats use: made when the first model is downloaded. */
  connect(): string;
  providerId(): string | null;
}

interface Active {
  pull: LocalPull;
  abort: AbortController;
  partial?: string;
}

/** Pictures on this computer (docs/specs/local-images.md): the short list, the downloads, the engine's server. */
export class LocalImages {
  private readonly pulls = new Map<LocalImageModelId, Active>();
  private server: ImageServer | null = null;
  private starting: Promise<ImageServer> | null = null;
  private lastUse = 0;
  /** Pictures being drawn now: the engine never goes in the middle of one. */
  private drawing = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly url: string | null;

  constructor(
    private readonly d: Deps,
    private readonly o: LocalImagesOptions = {},
  ) {
    this.url = o.engineUrl === undefined ? engineUrl() : o.engineUrl;
  }

  private get engineDir(): string {
    return join(this.d.dir, "engine", ENGINE_TAG);
  }

  private get modelsDir(): string {
    return join(this.d.dir, "models");
  }

  private pathOf(f: ImageFile): string {
    return join(this.modelsDir, fileKey(f));
  }

  private serverCommand(): string[] | null {
    if (this.o.serverCommand) return findServer(this.engineDir) ? this.o.serverCommand : null;
    const server = findServer(this.engineDir);
    return server ? [server] : null;
  }

  private async variant(model: ImageModelDef) {
    return variantFor(model, await this.d.hardware());
  }

  private installedFiles(files: ImageFile[]): boolean {
    return files.every((f) => existsSync(this.pathOf(f)));
  }

  async status(): Promise<LocalImagesStatus> {
    const hw = await this.d.hardware();
    const models = IMAGE_MODELS.flatMap((m) => {
      const v = variantFor(m, hw);
      if (!v) return [];
      const a = this.pulls.get(m.id);
      return [{ id: m.id, name: m.name, fit: v.fit, sizeBytes: sizeOf(v.files), installed: this.installedFiles(v.files), pull: a ? { ...a.pull } : null }];
    });
    return {
      supported: this.url !== null,
      engine: !!findServer(this.engineDir),
      running: this.server?.running ? (this.server.loaded.model as LocalImageModelId) : null,
      providerId: this.d.providerId(),
      models,
    };
  }

  /** The downloaded models, for the picture chats. */
  async installed(): Promise<ImageModelDef[]> {
    const hw = await this.d.hardware();
    return IMAGE_MODELS.filter((m) => {
      const v = variantFor(m, hw);
      return v && this.installedFiles(v.files);
    });
  }

  /** Starts downloading a model (and the engine, the first time), or returns the download already going. */
  async pull(id: LocalImageModelId): Promise<LocalPull> {
    if (this.url === null) throw new EngineError("There is no build of the engine for this system");
    const model = IMAGE_MODELS.find((m) => m.id === id)!;
    const v = await this.variant(model);
    if (!v) throw new EngineError("This model does not fit this computer");
    const going = this.pulls.get(id);
    if (going && !going.pull.done && !going.pull.paused) return { ...going.pull };
    const before = going?.pull.paused ? going.pull : null;
    const a: Active = {
      pull: { model: id, status: "starting", completed: before?.completed ?? 0, total: before?.total ?? sizeOf(v.files), done: false, error: null, paused: false, bytesPerSecond: null },
      abort: new AbortController(),
    };
    this.pulls.set(id, a);
    void this.download(a, v.files);
    return { ...a.pull };
  }

  private routes(): Route[] {
    const proxy = this.d.hf.proxy();
    return [{ label: "direct", fetch }, ...(proxy ? [{ label: "proxy", fetch: fetchVia(proxy) }] : [])];
  }

  private async download(a: Active, files: ImageFile[]): Promise<void> {
    const p = a.pull;
    const signal = a.abort.signal;
    let sample = { at: Date.now(), completed: p.completed };
    const measure = () => {
      const now = Date.now();
      const seconds = (now - sample.at) / 1000;
      if (seconds < 0.5) return;
      const rate = Math.max(0, (p.completed - sample.completed) / seconds);
      p.bytesPerSecond = p.bytesPerSecond === null ? rate : p.bytesPerSecond * 0.6 + rate * 0.4;
      sample = { at: now, completed: p.completed };
    };
    try {
      // Sizes and checksums from Hugging Face first, so the total is right from the start.
      p.status = "pulling manifest";
      const missing = files.filter((f) => !existsSync(this.pathOf(f)));
      const infos = await Promise.all(missing.map(async (f) => ({ f, info: await fileByPath(this.d.hf.apiUrl, f.repo, f.path, signal) })));
      const have = files.filter((f) => existsSync(this.pathOf(f))).reduce((s, f) => s + f.bytes, 0);
      let engineBytes = 0;
      let engineTotal = 0;
      const recount = (inFile: number, done: number) => {
        p.completed = have + engineBytes + done + inFile;
        p.total = have + engineTotal + infos.reduce((s, x) => s + x.info.size, 0);
        measure();
      };

      if (!findServer(this.engineDir)) {
        p.status = "downloading the engine";
        await installEngine({
          url: this.url!,
          dir: this.engineDir,
          fetch: this.routes()[0]!.fetch,
          signal,
          progress: (received, total) => {
            engineBytes = received;
            engineTotal = Math.max(total, received);
            recount(0, 0);
          },
        });
      }

      let done = 0;
      for (const { f, info } of infos) {
        if (signal.aborted) return;
        p.status = "downloading";
        const part = await downloadFile(
          {
            apiUrl: this.d.hf.apiUrl,
            bases: this.d.hf.bases,
            routes: this.routes(),
            dir: this.d.hf.dir,
            signal,
            partial: (path) => (a.partial = path),
            progress: (s) => {
              if (s.status === "downloading") recount(s.completed, done);
              else p.status = s.status;
            },
          },
          f.repo,
          info,
        );
        if (!part) return;
        mkdirSync(this.modelsDir, { recursive: true });
        renameSync(part, this.pathOf(f));
        a.partial = undefined;
        done += info.size;
        recount(0, done);
      }
      Object.assign(p, { done: true, error: null, status: "success", completed: p.total, bytesPerSecond: null });
      this.d.connect();
    } catch (err) {
      if (signal.aborted) return;
      Object.assign(p, { done: true, error: err instanceof Error ? err.message : String(err), bytesPerSecond: null });
    }
  }

  pause(id: LocalImageModelId): boolean {
    const a = this.pulls.get(id);
    if (!a || a.pull.done) return false;
    a.abort.abort();
    Object.assign(a.pull, { paused: true, bytesPerSecond: null, status: "paused" });
    return true;
  }

  cancel(id: LocalImageModelId): boolean {
    const a = this.pulls.get(id);
    if (!a) return false;
    a.abort.abort();
    this.pulls.delete(id);
    if (a.partial) {
      const file = a.partial;
      // The download lets go of the file a moment after the abort; Windows refuses to delete it before that.
      setTimeout(() => rmSync(file, { force: true }), 500).unref();
    }
    return true;
  }

  /** Deletes a model's files, except those another downloaded model needs. */
  async remove(id: LocalImageModelId): Promise<boolean> {
    const model = IMAGE_MODELS.find((m) => m.id === id)!;
    if (this.server?.loaded.model === id) this.stopServer();
    this.pulls.delete(id);
    const others = (await this.installed()).filter((m) => m.id !== id);
    const kept = new Set(others.flatMap((m) => m.variants.flat().map(fileKey)));
    let removed = false;
    for (const f of model.variants.flat()) {
      const path = this.pathOf(f);
      if (kept.has(fileKey(f)) || !existsSync(path)) continue;
      rmSync(path, { force: true });
      removed = true;
    }
    return removed;
  }

  /** Draws one picture with a downloaded model, starting the engine with it first when needed. */
  async draw(id: string, prompt: string, aspectRatio: string | undefined, signal?: AbortSignal): Promise<Buffer> {
    const model = IMAGE_MODELS.find((m) => m.id === id);
    const v = model ? await this.variant(model) : null;
    if (!model || !v || !this.installedFiles(v.files)) throw new EngineError("This model is not downloaded");
    const server = await this.serverFor(model, v.files, v.fit === "slow");
    const [width, height] = IMAGE_SIZES[aspectRatio ?? "1:1"] ?? IMAGE_SIZES["1:1"]!;
    this.touch();
    this.drawing++;
    try {
      return await server.draw(prompt, width, height, signal ?? new AbortController().signal);
    } finally {
      this.drawing--;
      this.touch();
    }
  }

  private async serverFor(model: ImageModelDef, files: ImageFile[], offload: boolean): Promise<ImageServer> {
    if (this.server?.running && this.server.loaded.model === model.id) return this.server;
    // One model at a time: another one's server goes first.
    await this.starting?.catch(() => {});
    if (this.server?.running && this.server.loaded.model === model.id) return this.server;
    this.stopServer();
    const command = this.serverCommand();
    if (!command) throw new EngineError("The engine is not downloaded");
    const paths = Object.fromEntries(files.map((f) => [f.role, this.pathOf(f)])) as Record<ImageFileRole, string>;
    const server = new ImageServer({ model: model.id, files: paths, settings: model.settings, offload }, command, this.o.serverEnv ?? {});
    this.starting = server.start().then(() => server);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    this.server = server;
    this.watchIdle();
    return server;
  }

  private touch(): void {
    this.lastUse = Date.now();
  }

  /** The engine holds gigabytes of video memory: it goes when no picture was asked for a while. */
  private watchIdle(): void {
    if (this.timer) return;
    const idleMs = this.o.idleMs ?? 10 * 60_000;
    this.timer = setInterval(() => {
      if (!this.server?.running) return this.stopWatching();
      if (this.drawing === 0 && Date.now() - this.lastUse >= idleMs) this.stopServer();
    }, Math.max(50, Math.min(idleMs / 4, 30_000)));
    this.timer.unref?.();
  }

  private stopWatching(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private stopServer(): void {
    this.stopWatching();
    this.server?.stop();
    this.server = null;
  }

  close(): void {
    for (const a of this.pulls.values()) a.abort.abort();
    this.pulls.clear();
    this.stopServer();
  }
}
