import type { Locale } from "@artel/shared";
import { en } from "./locales/en";
import { ru } from "./locales/ru";

export type MessageKey = keyof typeof ru;

export const dictionaries: Record<Locale, Record<MessageKey, string>> = { ru, en };

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const text = dictionaries[locale][key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** Best guess before settings load: Russian unless the system clearly prefers something else. */
export function guessLocale(languages: readonly string[]): Locale {
  const first = languages[0]?.toLowerCase() ?? "ru";
  return first.startsWith("ru") ? "ru" : first.startsWith("en") ? "en" : "ru";
}
