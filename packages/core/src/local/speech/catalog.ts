import type { LocalVoiceId } from "@drimvox/shared";

export interface VoiceDef {
  id: LocalVoiceId;
  name: string;
  lang: string;
  gender: "female" | "male";
  repo: string;
  /** The voice's model on Hugging Face; its settings file is the same path with ".json" after it. */
  path: string;
  /** Near enough for the list before Hugging Face is asked. */
  bytes: number;
}

const REPO = "rhasspy/piper-voices";

/**
 * Piper's voices for the interface's languages, medium quality: natural enough, quick on any processor (sizes checked
 * on Hugging Face 2026-10-26).
 */
export const VOICES: VoiceDef[] = [
  { id: "ru-irina", name: "Ирина", lang: "ru", gender: "female", repo: REPO, path: "ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx", bytes: 63_201_294 },
  { id: "ru-denis", name: "Денис", lang: "ru", gender: "male", repo: REPO, path: "ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx", bytes: 63_201_294 },
  { id: "ru-dmitri", name: "Дмитрий", lang: "ru", gender: "male", repo: REPO, path: "ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx", bytes: 63_201_294 },
  { id: "ru-ruslan", name: "Руслан", lang: "ru", gender: "male", repo: REPO, path: "ru/ru_RU/ruslan/medium/ru_RU-ruslan-medium.onnx", bytes: 63_201_294 },
  { id: "en-amy", name: "Amy", lang: "en", gender: "female", repo: REPO, path: "en/en_US/amy/medium/en_US-amy-medium.onnx", bytes: 63_201_294 },
  { id: "en-lessac", name: "Lessac", lang: "en", gender: "female", repo: REPO, path: "en/en_US/lessac/high/en_US-lessac-high.onnx", bytes: 113_895_201 },
];
