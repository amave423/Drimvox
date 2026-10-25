import type { LocalAudioModelId } from "@drimvox/shared";

export interface AudioModelDef {
  id: LocalAudioModelId;
  name: string;
  note: string;
  repo: string;
  path: string;
  /** Near enough for the list before Hugging Face is asked. */
  bytes: number;
}

/** whisper.cpp's own models on Hugging Face: small and quick, balanced, and the most accurate that still runs fast. */
export const AUDIO_MODELS: AudioModelDef[] = [
  { id: "whisper-base", name: "Whisper Base", note: "fast", repo: "ggerganov/whisper.cpp", path: "ggml-base.bin", bytes: 147_951_465 },
  { id: "whisper-small", name: "Whisper Small", note: "balanced", repo: "ggerganov/whisper.cpp", path: "ggml-small-q5_1.bin", bytes: 190_085_487 },
  { id: "whisper-turbo", name: "Whisper Large v3 Turbo", note: "accurate", repo: "ggerganov/whisper.cpp", path: "ggml-large-v3-turbo-q5_0.bin", bytes: 574_041_195 },
];
