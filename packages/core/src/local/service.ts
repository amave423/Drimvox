import { autoWindow, kvBytesPerToken, LOCAL_WINDOWS, windowBytes, windowFit } from "./window";
import type { LocalWindowChoice, LocalWindowView } from "@drimvox/shared";
import { LocalAudio, type LocalAudioOptions } from "./audio/service";
import { LocalSpeech, type LocalSpeechOptions } from "./speech/service";
import { HF_FILE_BASES } from "./hf-download";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OLLAMA_LINUX_COMMAND, OLLAMA_RELEASES, ollamaArchive, OllamaInstaller, ownOllama, unpackWithTar } from "./install";
import { presets, type HfRepo, type HfVariant, type LocalHardware, type LocalPick, type LocalPull, type LocalStatus } from "@drimvox/shared";
import type { ProviderRepo } from "../providers/repo";
import { LocalCatalog } from "./catalog";
import { detectHardware } from "./hardware";
import { findOllama, OllamaManager } from "./ollama";
import { LocalImages, type LocalImagesOptions } from "./images/service";

export interface LocalOptions {
  /** What starts `ollama serve`; found on this computer by default, null for "not installed". */
  command?: string[] | null;
  commandEnv?: Record<string, string>;
  /** Default 10 minutes. */
  idleMs?: number;
  /** Detected by default; tests give a fixed one. */
  hardware?: LocalHardware;
  registryUrl?: string;
  hfUrl?: string;
  /** Where GGUF files are downloaded from, in order (Hugging Face, then a mirror); tests give their own. */
  hfFiles?: string[];
  /** Where unfinished Hugging Face downloads wait between pauses; the data folder's "downloads" by default. */
  downloadsDir?: string;
  /** The proxy from the settings: Hugging Face files go through it when the direct way fails. */
  proxy?: () => string | null;
  /** Tests: where the archive comes from, whether to unpack it, and what is found afterwards. */
  install?: { url?: string; skipRun?: boolean; command?: string[]; can?: boolean };
  /** Where Drimvox unpacks its own Ollama; the data folder's "engines/ollama" by default. */
  ollamaDir?: string;
  /** Ollama's blobs folder; by default its own (OLLAMA_MODELS or ~/.ollama/models) for an Ollama on this computer. */
  ollamaBlobs?: string | null;
  /** Where the picture engine and its models live; the data folder's "images" by default. */
  imagesDir?: string;
  /** The picture engine (docs/specs/local-images.md); tests give a fake one. */
  images?: LocalImagesOptions;
  /** Where the speech engine and its models live; the data folder's "audio" by default. */
  audioDir?: string;
  /** The speech engine (docs/specs/local-audio.md); tests give a fake one. */
  audio?: LocalAudioOptions;
  /** Where Piper and its voices live; the data folder's "speech" by default. */
  speechDir?: string;
  /** Reading aloud (docs/specs/local-speech.md); tests give a fake engine. */
  speech?: LocalSpeechOptions;
  /** Where the window's choice and what "auto" picked are kept (the settings); in memory by default. */
  windowStore?: { get(): { choice: LocalWindowChoice; auto: number | null }; set(v: { choice: LocalWindowChoice; auto: number | null }): void };
}

function memoryStore() {
  let v: { choice: LocalWindowChoice; auto: number | null } = { choice: "auto", auto: null };
  return { get: () => v, set: (next: typeof v) => void (v = next) };
}

/** An address on this computer. */
const local = (url: string) => /\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url);

/** Where an Ollama on this computer keeps its files, as it does by default: OLLAMA_MODELS, or ~/.ollama/models. */
function ollamaBlobs(): string | null {
  const blobs = join(process.env.OLLAMA_MODELS ?? join(homedir(), ".ollama", "models"), "blobs");
  return existsSync(blobs) ? blobs : null;
}

/** Local models: Ollama on this computer, the catalog sized for it, and the chat provider that uses it. */
export class LocalModels {
  readonly ollama: OllamaManager;
  private readonly catalog: LocalCatalog;
  private readonly hardware: () => Promise<LocalHardware>;
  readonly installer: OllamaInstaller;
  readonly images: LocalImages;
  readonly audio: LocalAudio;
  readonly speech: LocalSpeech;
  private readonly canInstall: boolean;
  private readonly windowStore: NonNullable<LocalOptions["windowStore"]>;

  constructor(
    private readonly providers: ProviderRepo,
    /** Ollama's OpenAI-style address, as its provider preset has it (…/v1). */
    baseUrl: string,
    o: LocalOptions = {},
  ) {
    this.hardware = o.hardware ? async () => o.hardware! : detectHardware;
    this.windowStore = o.windowStore ?? memoryStore();
    const ollamaDir = o.ollamaDir ?? join(tmpdir(), "drimvox-ollama");
    // The user's own Ollama first (installed, on PATH); else the one Drimvox unpacked.
    const findAny = () => findOllama() ?? ownOllama(ollamaDir);
    this.ollama = new OllamaManager({
      apiUrl: baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, ""),
      command: o.command === undefined ? findAny() : o.command,
      // Tests that give their own Ollama never reach into the computer's real one.
      blobs: () => (o.ollamaBlobs !== undefined ? o.ollamaBlobs : o.command === undefined && local(baseUrl) ? ollamaBlobs() : null),
      commandEnv: o.commandEnv,
      idleMs: o.idleMs ?? 10 * 60_000,
      hardware: this.hardware,
      window: () => {
        const w = this.windowStore.get();
        return w.choice === "auto" ? w.auto : w.choice;
      },
      onPulled: () => this.afterPull(),
      // The list from before (Ollama's own small window) goes: seen live, the chat said 4 096 while Ollama held 65 536.
      onStarted: () => this.forgetList(),
      hf: { apiUrl: o.hfUrl ?? "https://huggingface.co", bases: o.hfFiles ?? HF_FILE_BASES, dir: o.downloadsDir ?? join(tmpdir(), "drimvox-downloads"), proxy: o.proxy ?? (() => null) },
    });
    const test = o.install;
    const archive = ollamaArchive();
    this.canInstall = test?.can ?? !!archive;
    this.installer = new OllamaInstaller({
      url: test?.url ?? `${OLLAMA_RELEASES}/${archive ?? "ollama-windows-amd64.zip"}`,
      dir: ollamaDir,
      unpack: test?.skipRun ? async (_, into) => void mkdirSync(into, { recursive: true }) : unpackWithTar,
      found: () => {
        const command = test?.command ?? findAny();
        if (command) this.ollama.setCommand(command);
        return !!command;
      },
    });
    const hf = { apiUrl: o.hfUrl ?? "https://huggingface.co", bases: o.hfFiles ?? HF_FILE_BASES, dir: o.downloadsDir ?? join(tmpdir(), "drimvox-downloads"), proxy: o.proxy ?? (() => null) };
    this.images = new LocalImages(
      {
        dir: o.imagesDir ?? join(tmpdir(), "drimvox-images"),
        hardware: this.hardware,
        hf,
        providerId: () => this.providers.list().find((p) => p.preset === "sdcpp")?.id ?? null,
        connect: () => this.providers.list().find((p) => p.preset === "sdcpp")?.id ?? this.providers.create({ preset: "sdcpp" }).id,
      },
      o.images,
    );
    this.audio = new LocalAudio(
      {
        dir: o.audioDir ?? join(tmpdir(), "drimvox-audio"),
        hf,
        providerId: () => this.providers.list().find((p) => p.preset === "whispercpp")?.id ?? null,
        connect: () => this.providers.list().find((p) => p.preset === "whispercpp")?.id ?? this.providers.create({ preset: "whispercpp" }).id,
      },
      o.audio,
    );
    this.speech = new LocalSpeech({ dir: o.speechDir ?? join(tmpdir(), "drimvox-speech"), hf }, o.speech);
    this.catalog = new LocalCatalog({ registryUrl: o.registryUrl ?? "https://registry.ollama.ai", hfUrl: o.hfUrl ?? "https://huggingface.co" });
  }

  /** The provider that talks to this Ollama, if there is one. */
  providerId(): string | null {
    return this.providers.list().find((p) => p.preset === "ollama" && this.ollama.handles(p.baseUrl))?.id ?? null;
  }

  /** Makes sure the chat can use the downloaded models. */
  connect(): string {
    return this.providerId() ?? this.providers.create({ preset: "ollama", name: presets.ollama.name }).id;
  }

  /**
   * At start: an Ollama that already runs with models (a service on a server, models pulled by its own command) is
   * connected without starting anything, so the chat lists them before anyone opens the local models' sheet.
   */
  async connectIfServed(): Promise<void> {
    if (this.providerId()) return;
    if ((await this.ollama.models()).length > 0) this.connect();
  }

  /** The Ollama provider's cached model list goes, if there is a provider. */
  private forgetList(): void {
    const id = this.providerId();
    if (id) this.providers.update(id, {});
  }

  private afterPull(): void {
    // A fresh timestamp drops the provider's cached model list, so the new model shows at once.
    this.providers.update(this.connect(), {});
  }

  async status(): Promise<LocalStatus> {
    const s = await this.ollama.status();
    // Models already in Ollama (downloaded before, by its own command, or on a fresh server) are usable at once: the
    // chat said "connect a neural network" and it read as "an API key is needed" (seen on the user's server).
    if (s.running && s.models.length > 0 && !this.providerId()) this.connect();
    return {
      ...s,
      ...(this.installer.state().state === "done" ? { installed: true } : {}),
      hardware: await this.hardware(),
      providerId: this.providerId(),
      install: this.installer.state(),
      canInstall: this.canInstall,
      installCommand: process.platform === "linux" ? OLLAMA_LINUX_COMMAND : null,
    };
  }

  /** The window's choice and where each window would run for each downloaded model (local/window.ts). */
  async windowView(): Promise<LocalWindowView> {
    const hw = await this.hardware();
    const running = await this.ollama.ensureRunning();
    const models = running ? await this.ollama.models() : [];
    const sized = await Promise.all(models.map(async (m) => ({ ...m, perToken: kvBytesPerToken(await this.ollama.info(m.name)) })));
    const auto = autoWindow(hw, sized);
    const stored = this.windowStore.get();
    // Remembered for the next start: Ollama's models are not known before it runs.
    if (models.length && stored.auto !== auto) this.windowStore.set({ ...stored, auto });
    return {
      choice: stored.choice,
      auto,
      applied: this.ollama.appliedWindow(),
      userOllama: await this.ollama.foreign(),
      models: sized.map((m) => ({
        name: m.name,
        sizeBytes: m.sizeBytes,
        options: LOCAL_WINDOWS.map((tokens) => ({
          tokens,
          bytes: m.perToken === null ? null : Math.round(windowBytes(m.sizeBytes, m.perToken, tokens)),
          fit: m.perToken === null ? null : windowFit(m.sizeBytes, m.perToken, tokens, hw),
        })),
      })),
    };
  }

  /** A new choice: the Ollama Drimvox started is restarted with it at the next request. */
  async setWindow(choice: LocalWindowChoice): Promise<LocalWindowView> {
    this.windowStore.set({ ...this.windowStore.get(), choice });
    this.ollama.restart();
    this.forgetList();
    return this.windowView();
  }

  private async installed(): Promise<string[]> {
    if (!(await this.ollama.ensureRunning())) return [];
    return (await this.ollama.models()).map((m) => m.name);
  }

  async picks(): Promise<LocalPick[]> {
    return this.catalog.picks(await this.hardware(), await this.installed());
  }

  async search(query: string): Promise<HfRepo[]> {
    return this.catalog.search(query, await this.hardware());
  }

  async variants(repo: string): Promise<HfVariant[]> {
    return this.catalog.variants(repo, await this.hardware(), await this.installed());
  }

  pull(model: string): Promise<LocalPull> {
    return this.ollama.pull(model);
  }

  pause(model: string): boolean {
    return this.ollama.pause(model);
  }

  cancel(model: string): boolean {
    return this.ollama.cancel(model);
  }

  remove(model: string): Promise<boolean> {
    return this.ollama.remove(model);
  }

  close(): void {
    this.ollama.close();
    this.images.close();
  }
}
