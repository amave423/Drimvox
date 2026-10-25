import { LocalAudio, type LocalAudioOptions } from "./audio/service";
import { LocalSpeech, type LocalSpeechOptions } from "./speech/service";
import { HF_FILE_BASES } from "./hf-download";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OLLAMA_LINUX_COMMAND, OLLAMA_SETUP_URL, OllamaInstaller, runSetup } from "./install";
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
  /** Tests: where the setup comes from, what runs it, and whether Ollama is there afterwards. */
  install?: { url?: string; skipRun?: boolean; command?: string[]; can?: boolean };
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

  constructor(
    private readonly providers: ProviderRepo,
    /** Ollama's OpenAI-style address, as its provider preset has it (…/v1). */
    baseUrl: string,
    o: LocalOptions = {},
  ) {
    this.hardware = o.hardware ? async () => o.hardware! : detectHardware;
    this.ollama = new OllamaManager({
      apiUrl: baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, ""),
      command: o.command === undefined ? findOllama() : o.command,
      commandEnv: o.commandEnv,
      idleMs: o.idleMs ?? 10 * 60_000,
      hardware: this.hardware,
      onPulled: () => this.afterPull(),
      hf: { apiUrl: o.hfUrl ?? "https://huggingface.co", bases: o.hfFiles ?? HF_FILE_BASES, dir: o.downloadsDir ?? join(tmpdir(), "drimvox-downloads"), proxy: o.proxy ?? (() => null) },
    });
    const test = o.install;
    this.canInstall = test?.can ?? process.platform === "win32";
    this.installer = new OllamaInstaller({
      url: test?.url ?? OLLAMA_SETUP_URL,
      dir: join(tmpdir(), "drimvox-ollama-setup"),
      run: test?.skipRun ? async () => {} : runSetup,
      found: () => {
        const command = test?.command ?? findOllama();
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

  private afterPull(): void {
    // A fresh timestamp drops the provider's cached model list, so the new model shows at once.
    this.providers.update(this.connect(), {});
  }

  async status(): Promise<LocalStatus> {
    const s = await this.ollama.status();
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
