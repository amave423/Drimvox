import type { MediaModel } from "@drimvox/shared";
import type { PendingFile } from "./Attachments";

/** What is wrong with the files for a picture or a clip, before they go (the core checks the same, docs/specs/media.md). */
export type PhotoProblem = "photos_only" | "no_photo_input" | "photo_required" | "too_many_photos";

export const isPhoto = (f: PendingFile) => /^image\//.test(f.file.type);

/** Null when the model can take these files: only photos, as many as it takes, at least as many as it needs. */
export function photoProblem(model: MediaModel | null, files: PendingFile[]): PhotoProblem | null {
  if (!model) return null;
  if (files.some((f) => !isPhoto(f))) return "photos_only";
  if (files.length > 0 && !model.photos) return "no_photo_input";
  if (model.photos && files.length < model.photos.min) return "photo_required";
  if (model.photos && files.length > model.photos.max) return "too_many_photos";
  return null;
}
