import type { SearchEngine } from "@drimvox/shared";

/**
 * What the address field opens: an address as is (https:// added), anything else as a search (asked for: typing a
 * search into it, as in any browser).
 */
export function addressOf(text: string, locale: "ru" | "en", engine: SearchEngine = "auto"): string {
  const typed = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) || /^about:/i.test(typed)) return typed;
  if (!/\s/.test(typed) && /^(localhost|[\w-]+(\.[\w-]+)+|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(typed)) {
    return `${/^(localhost|127\.|\d{1,3}(\.\d{1,3}){3})/.test(typed) ? "http" : "https"}://${typed}`;
  }
  const q = encodeURIComponent(typed);
  const chosen = engine === "auto" ? (locale === "ru" ? "yandex" : "bing") : engine;
  return {
    google: `https://www.google.com/search?q=${q}`,
    yandex: `https://yandex.ru/search/?text=${q}`,
    duckduckgo: `https://duckduckgo.com/?q=${q}`,
    bing: `https://www.bing.com/search?q=${q}`,
  }[chosen];
}
