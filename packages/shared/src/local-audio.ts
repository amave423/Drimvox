import { z } from "zod";
import type { LocalPull } from "./local";

/** Speech models Drimvox runs on this computer with whisper.cpp (docs/specs/local-audio.md). */
export const localAudioModelIds = ["whisper-base", "whisper-small", "whisper-turbo"] as const;
export type LocalAudioModelId = (typeof localAudioModelIds)[number];

export interface LocalAudioModel {
  id: LocalAudioModelId;
  name: string;
  /** What it is good for, short. */
  note: string;
  sizeBytes: number;
  installed: boolean;
  pull: LocalPull | null;
}

export interface LocalAudioStatus {
  /** There is a build of the engine for this system. */
  supported: boolean;
  /** The engine is downloaded. */
  engine: boolean;
  /** The provider dictation uses; null until a model is downloaded. */
  providerId: string | null;
  models: LocalAudioModel[];
}

export const localAudioPullSchema = z.object({ model: z.enum(localAudioModelIds) }).strict();
