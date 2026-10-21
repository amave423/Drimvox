import { z } from "zod";

/** What the computer has for running models. */
export interface LocalHardware {
  ramBytes: number;
  /** The largest video card; null when none was found. */
  gpu: { name: string; vramBytes: number } | null;
  /** Apple Silicon: the video card shares the main memory. */
  unified: boolean;
}

/** "fast": the model fits in video memory; "slow": only together with main memory, part of it runs on the processor. */
export type LocalFit = "fast" | "slow";

export interface LocalModel {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface LocalPull {
  model: string;
  /** Ollama's own words: "pulling manifest", "downloading", "verifying sha256 digest", "success". */
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error: string | null;
  /** Stopped by the user; pulling again goes on where it stopped. */
  paused: boolean;
  /** How fast it goes now, while it goes. */
  bytesPerSecond: number | null;
}

/** Installing Ollama from Drimvox: the download, then the official setup. */
export interface OllamaInstall {
  state: "idle" | "downloading" | "installing" | "done" | "failed";
  received: number;
  total: number | null;
  /** "download": it did not come; "not_found": the setup ran but Ollama is still not there. */
  error: "download" | "not_found" | null;
}

export interface LocalStatus {
  /** Ollama's program was found on this computer, or it answers anyway. */
  installed: boolean;
  running: boolean;
  /** Drimvox started it and stops it when it is idle. */
  managed: boolean;
  version: string | null;
  hardware: LocalHardware;
  models: LocalModel[];
  pulls: LocalPull[];
  /** The provider that talks to this Ollama, if there is one. */
  providerId: string | null;
  /** Ollama installed from Drimvox, as far as it got. */
  install: OllamaInstall;
  /** Drimvox can install Ollama here (Windows); elsewhere it shows the command. */
  canInstall: boolean;
  installCommand: string | null;
}

/** What a model is good for, as the catalog shows it. */
export const localUses = ["chat", "code", "vision", "tools"] as const;
export type LocalUse = (typeof localUses)[number];

/** A model from Drimvox's own short list, sized for this computer. */
export interface LocalPick {
  /** The Ollama name, such as gemma4:e4b. */
  model: string;
  /** Picks of one family share their description in the interface texts. */
  family: string;
  uses: LocalUse[];
  sizeBytes: number;
  fit: LocalFit;
  installed: boolean;
}

/** A GGUF repository on Hugging Face that has at least one variant this computer can run. */
export interface HfRepo {
  repo: string;
  downloads: number;
  likes: number;
  /** Parameters, when Hugging Face knows them. */
  params: number | null;
  updatedAt: string | null;
  /** The author says it answers without refusals (by its name or tags); Drimvox cannot check it. */
  unfiltered: boolean;
  /** Why it cannot be downloaded here: not a model that talks (a picture or video generator), or too big; null when it can. */
  unsupported: "not_chat" | "too_big" | null;
}

/** One quantization of a repository: the file Ollama pulls as hf.co/<repo>:<quant>. */
export interface HfVariant {
  quant: string;
  file: string;
  sizeBytes: number;
  fit: LocalFit;
  recommended: boolean;
  model: string;
  installed: boolean;
}

/** Names Ollama can pull: its catalog (gemma4:e4b, library/x) or a Hugging Face file (hf.co/user/repo:Q4_K_M). */
export const localModelName = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^(hf\.co\/[\w.-]+\/[\w.-]+(:[\w.-]+)?|[\w.-]+(\/[\w.-]+)?(:[\w.-]+)?)$/);
export const localPullSchema = z.object({ model: localModelName }).strict();
export const hfRepoName = z
  .string()
  .trim()
  .regex(/^[\w.-]+\/[\w.-]+$/);
