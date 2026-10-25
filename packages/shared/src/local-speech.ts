import { z } from "zod";
import type { LocalPull } from "./local";

/** Voices Drimvox reads answers aloud with on this computer, through Piper (docs/specs/local-speech.md). */
export const localVoiceIds = ["ru-irina", "ru-denis", "ru-dmitri", "ru-ruslan", "en-amy", "en-lessac"] as const;
export type LocalVoiceId = (typeof localVoiceIds)[number];

export interface LocalVoice {
  id: LocalVoiceId;
  name: string;
  /** The language it speaks, as the interface names languages ("ru", "en"). */
  lang: string;
  gender: "female" | "male";
  sizeBytes: number;
  installed: boolean;
  pull: LocalPull | null;
}

export interface LocalSpeechStatus {
  /** There is a build of the engine for this system. */
  supported: boolean;
  /** The engine is downloaded. */
  engine: boolean;
  voices: LocalVoice[];
}

export const localVoicePullSchema = z.object({ voice: z.enum(localVoiceIds) }).strict();
/** A text to read aloud; long answers are read in full, up to a limit. */
export const speakSchema = z.object({ text: z.string().trim().min(1).max(20_000) }).strict();
