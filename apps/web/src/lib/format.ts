import type { Currency, Locale } from "@artel/shared";

/**
 * Amounts arrive in dollars. With rubles chosen in the settings they are shown in rubles at the rate the core
 * gives; the app sets this once settings and the rate are known.
 */
let display: { currency: Currency; usdRub: number } = { currency: "USD", usdRub: 1 };

export function setDisplayCurrency(currency: Currency, usdRub: number): void {
  display = { currency, usdRub: usdRub > 0 ? usdRub : 1 };
}

export function displayCurrency(): { currency: Currency; usdRub: number } {
  return display;
}

/** Ruble amounts: a comma, the sign after the number. */
function rub(value: number, decimals: number): string {
  return `${value.toFixed(decimals).replace(".", ",")} ₽`;
}

/** Costs here are often fractions of a cent, so small amounts keep four decimals. */
export function formatUsd(value: number): string {
  if (display.currency === "RUB") {
    const v = value * display.usdRub;
    if (v === 0) return "0 ₽";
    if (v < 0.001) return "< 0,001 ₽";
    return rub(v, v < 1 ? 3 : v < 1000 ? 2 : 0);
  }
  if (value === 0) return "$0";
  if (value < 0.0001) return "< $0.0001";
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number, locale: Locale): string {
  if (value < 1000) return String(value);
  if (value >= 1_000_000) {
    const millions = (value / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return locale === "ru" ? `${millions.replace(".", ",")} млн` : `${millions}M`;
  }
  const thousands = value / 1000;
  const short = thousands >= 100 ? Math.round(thousands).toString() : thousands.toFixed(1).replace(/\.0$/, "");
  return locale === "ru" ? `${short.replace(".", ",")} тыс.` : `${short}k`;
}

/** Price per 1M tokens, the unit providers publish. */
export function formatPrice(value: number): string {
  if (display.currency === "RUB") {
    const v = Number((value * display.usdRub).toFixed(4));
    if (v === 0) return "0 ₽";
    return Number.isInteger(v) ? rub(v, 0) : rub(v, 2);
  }
  if (value === 0) return "$0";
  if (Number.isInteger(value)) return `$${value}`;
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** Budgets are whole cents. */
export function formatBudget(value: number): string {
  if (display.currency === "RUB") {
    const v = value * display.usdRub;
    return rub(v, v >= 10 ? 0 : 2);
  }
  return `$${value.toFixed(2)}`;
}

export function startOfToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** An amount in dollars as the user types it: in rubles when rubles are shown, rounded to whole units above 10. */
export function toShown(usd: number): number {
  const v = display.currency === "RUB" ? usd * display.usdRub : usd;
  return v >= 10 ? Math.round(v) : Math.round(v * 100) / 100;
}

/** What the user typed, back in dollars. */
export function fromShown(value: number): number {
  return display.currency === "RUB" ? value / display.usdRub : value;
}

/** The sign of the shown currency, for labels. */
export function shownSign(): string {
  return display.currency === "RUB" ? "₽" : "$";
}
