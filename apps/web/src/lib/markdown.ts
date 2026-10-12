/**
 * Models write formulas as \( … \) and \[ … \] as often as with dollar signs; the Markdown math plugin knows
 * only dollars. Code blocks and inline code keep their backslashes.
 */
export function normalizeMath(text: string): string {
  // Split into code (fenced blocks and inline spans) and prose; only prose is touched.
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\\\[([\s\S]+?)\\\]/g, "$$$$$1$$$$").replace(/\\\(([\s\S]+?)\\\)/g, "$$$1$$")))
    .join("");
}
