import { z } from "zod";
import type { LocalPull } from "./local";

/** Speech models Drimvox runs on this computer with whisper.cpp (docs/specs/local-audio.md). */
export const localAudioModelIds = ["whisper-base", "whisper-small", "whisper-turbo"] as const;
export type LocalAudioModelId = (typeof localAudioModelIds)[number];

/** A whisper.cpp model found on Hugging Face: "hf:<repo>:<file>", the file one of ggml's .bin. */
export const foundAudioModelId = z.string().max(400).regex(/^hf:[\w.-]+\/[\w.-]+:[\w./-]+\.bin$/);
export const audioModelId = z.union([z.enum(localAudioModelIds), foundAudioModelId]);

export interface LocalAudioModel {
  id: string;
  name: string;
  /** What it is good for, short; none for a model found on Hugging Face. */
  note: string | null;
  source: "checked" | "hf";
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

/** A repository of speech models on Hugging Face; runnable when it has whisper.cpp's files. */
export interface HfAudioRepo {
  repo: string;
  downloads: number;
  runnable: boolean;
}

/** One of a repository's whisper.cpp files. */
export interface HfAudioFile {
  model: string;
  file: string;
  sizeBytes: number;
  installed: boolean;
}

export const localAudioPullSchema = z.object({ model: audioModelId }).strict();
export const localAudioSearchSchema = z.object({ q: z.string().trim().min(1).max(100) });
