import { z } from "zod";
import type { LocalFit, LocalPull } from "./local";

/** The checked picture and video models (docs/specs/local-images.md): each one also names a family for models found on Hugging Face. */
export const localImageModelIds = ["z-image-turbo", "qwen-image-2512", "wan2.2-ti2v-5b", "wan2.1-t2v-1.3b"] as const;
export type CheckedImageModelId = (typeof localImageModelIds)[number];
/** A checked model, or a file found on Hugging Face: `hf:<repo>:<path>`. */
export type LocalImageModelId = string;
export const localImageModelId = z
  .string()
  .max(400)
  .refine((id) => (localImageModelIds as readonly string[]).includes(id) || /^hf:[\w.-]+\/[\w.-]+:[\w./-]+\.(gguf|safetensors)$/.test(id), "Not a picture or video model");

/** A picture model of the short list, sized for this computer. */
export interface LocalImageModel {
  id: LocalImageModelId;
  /** What it makes: pictures, or clips. */
  kind: "image" | "video";
  name: string;
  /** From Drimvox's checked list, or found on Hugging Face (then its family's other files come with it). */
  source: "checked" | "hf";
  fit: LocalFit;
  /** All its files together, the engine not counted. */
  sizeBytes: number;
  installed: boolean;
  /** The download, while it goes or after it stopped; null when there is none. */
  pull: LocalPull | null;
}

export interface LocalImagesStatus {
  /** There is a build of the engine for this system. */
  supported: boolean;
  /** The engine is downloaded. */
  engine: boolean;
  /** The engine downloaded alone (the installer's box, the sheet's button), while it goes or after it failed. */
  enginePull: LocalPull | null;
  /** Its server runs now, and with which model. */
  running: LocalImageModelId | null;
  /** The provider the picture chats use; null until a model is downloaded. */
  providerId: string | null;
  /** Only the models this computer can run. */
  models: LocalImageModel[];
}

export const localImagePullSchema = z.object({ model: localImageModelId }).strict();

/** A repository found on Hugging Face by what its models make. */
export interface HfMediaRepo {
  repo: string;
  downloads: number;
  likes: number;
  /** The checked model whose family it belongs to: its other files come from there. Null: Drimvox cannot run it yet. */
  family: CheckedImageModelId | null;
}

/** One model file of such a repository. */
export interface HfMediaFile {
  /** The id to download it by. */
  model: string;
  file: string;
  quant: string | null;
  /** The file with its family's other files. */
  sizeBytes: number;
  /** Null: it does not fit this computer. */
  fit: LocalFit | null;
  recommended: boolean;
  installed: boolean;
}

export const hfMediaSearchSchema = z.object({ kind: z.enum(["image", "video"]), q: z.string().trim().min(1).max(200) }).strict();
