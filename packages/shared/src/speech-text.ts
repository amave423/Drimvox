/**
 * The words of an answer to read aloud (asked for: no emoji, code or symbols read out): code blocks and inline code,
 * addresses, emoji, Markdown and table marks and arrows go; links keep their words; lines become sentences.
 */
export function speechText(text: string): string {
  return (
    text
      // Code: blocks and inline, and formulas.
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`\n]*`/g, " ")
      .replace(/\$\$[\s\S]*?\$\$/g, " ")
      // Links keep their words; pictures and bare addresses go.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\bhttps?:\/\/\S+/gi, " ")
      .replace(/\bwww\.\S+/gi, " ")
      .replace(/<[^>\n]+>/g, " ")
      // Tables: the separator rows go, the cells read as a list.
      .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, " ")
      .replace(/\s*\|\s*/g, ", ")
      // Headings, quotes and list marks at the start of a line.
      .replace(/^\s{0,3}(#{1,6}|>+|[-*+•]|\d+[.)])\s+/gm, "")
      // Emoji, their joiners and variation marks, and pictographic symbols.
      .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}‍︎️⃣]/gu, " ")
      // Arrows, marks and other symbols that are not words.
      .replace(/[←-⇿⌀-⏿■-◿☀-⟿⤀-⥿⬀-⯿✓✔✗✘★☆•·◦▪▫§¶†‡※∗~^_*#=+<>{}[\]\\|@]/g, " ")
      // Lines end sentences, so the voice pauses between them.
      .replace(/([^.!?:;,\s])\s*\n+/g, "$1.\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .replace(/(\s*[.,]){2,}/g, (m) => (m.includes(".") ? "." : ","))
      .trim()
  );
}
