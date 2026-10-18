import type { AttachmentView } from "@artel/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { useAuthorizedUrl } from "../../lib/media";

/** At most this many files per message, this many bytes all together (docs/specs/chat-attachments.md). */
export const MAX_FILES = 10;
export const MAX_BYTES = 20 * 1024 * 1024;

export interface PendingFile {
  key: string;
  file: File;
}

const isImage = (type: string, name: string) => /^image\/(png|jpe?g|webp|gif)$/.test(type) || /\.(png|jpe?g|webp|gif)$/i.test(name);

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Pictures go to models at most this big: providers refuse larger ones (seen: a 4.5 MB photo was "too heavy"). */
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2048;
const SENT_AS_IS = /^image\/(png|jpeg|webp|gif)$/;

/**
 * A picture as models take it: other formats (BMP, TIFF, AVIF…) and big photos are redrawn as WebP, at most 2048 px on
 * the long side. Null when the picture cannot be read here (HEIC from a phone, say). Other files go as they are.
 */
export async function prepareFile(file: File): Promise<File | null> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  if (SENT_AS_IS.test(file.type) && file.size <= MAX_IMAGE_BYTES) {
    const size = await imageSize(file);
    if (size && Math.max(size.width, size.height) <= MAX_IMAGE_SIDE) return file;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.9, 0.8, 0.65]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", quality));
    if (blob && (blob.size <= MAX_IMAGE_BYTES || quality === 0.65)) return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".webp", { type: "image/webp" });
  }
  return null;
}

async function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/** The file's bytes as base64, for the upload. */
export async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Files waiting to go with the next message, above the text field. */
export function PendingFiles({ files, onRemove }: { files: PendingFile[]; onRemove(key: string): void }) {
  const { t } = useApp();
  if (files.length === 0) return null;
  return (
    <ul className="attachments is-pending">
      {files.map((f) => (
        <li key={f.key} className="attachment">
          {isImage(f.file.type, f.file.name) ? <LocalThumb file={f.file} /> : <span className="attachment-icon" aria-hidden>📄</span>}
          <span className="attachment-name">{f.file.name}</span>
          <span className="muted mono">{formatSize(f.file.size)}</span>
          <button type="button" className="link" aria-label={t("attach.remove", { name: f.file.name })} onClick={() => onRemove(f.key)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function LocalThumb({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src ? <img className="attachment-thumb" src={src} alt="" /> : null;
}

/** Files sent with a message: pictures as thumbnails, the rest by name. */
export function SentFiles({ chatId, files }: { chatId: string; files: AttachmentView[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="attachments">
      {files.map((f) => (
        <li key={f.id} className="attachment">
          {f.kind === "image" ? <SentThumb chatId={chatId} file={f} /> : <span className="attachment-icon" aria-hidden>📄</span>}
          <span className="attachment-name">{f.name}</span>
          <span className="muted mono">{formatSize(f.size)}</span>
        </li>
      ))}
    </ul>
  );
}

function SentThumb({ chatId, file }: { chatId: string; file: AttachmentView }) {
  const { token } = useApp();
  const src = useAuthorizedUrl(`/api/chats/${chatId}/attachments/${file.id}`, token);
  return src ? <img className="attachment-thumb" src={src} alt={file.name} /> : null;
}
