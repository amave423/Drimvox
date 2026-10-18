import { unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * What a file attached to a chat message gives the model (docs/specs/chat-attachments.md): a picture as a picture,
 * text (code, PDF, the text files inside a ZIP) as text, anything else as its name only.
 */
export type AttachmentKind = "image" | "text" | "none";

/** Characters of one file's text the model gets at most. */
export const TEXT_LIMIT = 100_000;
/** Characters of a ZIP's text files, all together. */
const ZIP_LIMIT = 200_000;
const ZIP_FILES = 200;

const IMAGE = /^image\/(png|jpe?g|webp|gif)$/;
const IMAGE_NAME = /\.(png|jpe?g|webp|gif)$/i;

export async function extract(name: string, type: string, data: Buffer): Promise<{ kind: AttachmentKind; text: string | null }> {
  if (IMAGE.test(type) || IMAGE_NAME.test(name)) return { kind: "image", text: null };
  if (type === "application/pdf" || /\.pdf$/i.test(name)) {
    const text = await pdfText(data);
    return text === null ? { kind: "none", text: null } : { kind: "text", text: clip(text, TEXT_LIMIT) };
  }
  if (type === "application/zip" || /\.zip$/i.test(name)) {
    const text = zipText(data);
    return text === null ? { kind: "none", text: null } : { kind: "text", text };
  }
  const text = asText(data);
  return text === null ? { kind: "none", text: null } : { kind: "text", text: clip(text, TEXT_LIMIT) };
}

/** UTF-8 text, or null for a binary file. */
function asText(data: Buffer): string | null {
  if (data.subarray(0, 8000).includes(0)) return null;
  const text = data.toString("utf8");
  // Many replacement characters: not text in UTF-8.
  const bad = (text.slice(0, 8000).match(/�/g) ?? []).length;
  return bad > 20 ? null : text;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[… cut by Artel: ${text.length - limit} more characters]` : text;
}

async function pdfText(data: Buffer): Promise<string | null> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(pdf, { mergePages: true });
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** The archive's file list, then its text files one after another. */
function zipText(data: Buffer): string | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(data));
  } catch {
    return null;
  }
  const names = Object.keys(files).filter((n) => !n.endsWith("/"));
  const parts = [`Files in the archive (${names.length}):`, ...names.slice(0, ZIP_FILES).map((n) => `- ${n}`)];
  if (names.length > ZIP_FILES) parts.push(`- … ${names.length - ZIP_FILES} more`);
  let left = ZIP_LIMIT;
  for (const n of names.slice(0, ZIP_FILES)) {
    if (IMAGE_NAME.test(n) || left <= 0) continue;
    const text = asText(Buffer.from(files[n]!));
    if (text === null) continue;
    const shown = clip(text, Math.min(left, TEXT_LIMIT));
    left -= shown.length;
    parts.push("", `=== ${n} ===`, shown);
  }
  return parts.join("\n");
}

/** A picture's media type, from its type or its name. */
export function imageType(type: string, name: string): string {
  if (IMAGE.test(type)) return type;
  const ext = name.toLowerCase().split(".").pop();
  return ext === "jpg" ? "image/jpeg" : `image/${ext}`;
}
