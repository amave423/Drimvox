/**
 * What is typed in a message box and not sent yet, per chat or project (asked for: the text stays when one leaves the
 * project or the chat and comes back). Kept in this window's storage: a convenience, gone with the browser's data.
 */
const keyOf = (box: string) => `drimvox.draft:${box}`;

export function readDraft(box: string | undefined): string {
  if (!box) return "";
  try {
    return localStorage.getItem(keyOf(box)) ?? "";
  } catch {
    return "";
  }
}

export function keepDraft(box: string | undefined, text: string): void {
  if (!box) return;
  try {
    if (text) localStorage.setItem(keyOf(box), text);
    else localStorage.removeItem(keyOf(box));
  } catch {
    // Storage off (a private window): the text simply is not kept.
  }
}
