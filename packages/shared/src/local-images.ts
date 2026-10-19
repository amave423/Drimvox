import { z } from "zod";
import type { LocalFit, LocalPull } from "./local";

/** Picture models Artel can run on this computer (docs/specs/local-images.md): only checked ones, no search. */
export const localImageModelIds = ["z-image-turbo", "qwen-image-2512"] as const;
export type LocalImageModelId = (typeof localImageModelIds)[number];

/** A picture model of the short list, sized for this computer. */
export interface LocalImageModel {
  id: LocalImageModelId;
  name: string;
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

export const localImagePullSchema = z.object({ model: z.enum(localImageModelIds) }).strict();
