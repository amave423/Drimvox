import type { Locale } from "@artel/shared";

/** Costs here are often fractions of a cent, so small amounts keep four decimals. */
export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.0001) return "< $0.0001";
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number, locale: Locale): string {
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  const short = thousands >= 100 ? Math.round(thousands).toString() : thousands.toFixed(1).replace(/\.0$/, "");
  return locale === "ru" ? `${short.replace(".", ",")} тыс.` : `${short}k`;
}

/** Price per 1M tokens, the unit providers publish. */
export function formatPrice(value: number): string {
  if (value === 0) return "$0";
  if (Number.isInteger(value)) return `$${value}`;
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

export function startOfToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
