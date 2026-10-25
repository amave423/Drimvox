/** Web addresses in plain text: what is a link in the user's own message and in the message box. */
const URL_RE = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}»]/g;

export interface TextPart {
  text: string;
  /** Set when this part is a web address. */
  url?: string;
}

/** The text cut into plain parts and addresses, in order; joined back they give the text unchanged. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index! > at) parts.push({ text: text.slice(at, m.index) });
    parts.push({ text: m[0], url: m[0] });
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
