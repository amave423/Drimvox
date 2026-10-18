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
