/**
 * Rubles per dollar. Artel keeps every price and cost in dollars; providers that bill in rubles are
 * converted on the way in, and the interface converts back when the user picks rubles.
 */
export type RateSource = () => Promise<number>;

const CBR = "https://www.cbr-xml-daily.ru/daily_json.js";
const TTL_MS = 6 * 60 * 60_000;
/** Used only until the first successful fetch, when the Central Bank's feed cannot be reached. */
const FALLBACK = 80;

const fromCbr: RateSource = async () => {
  const res = await fetch(CBR, { signal: AbortSignal.timeout(10_000) });
  const body = (await res.json()) as { Valute?: { USD?: { Value?: number } } };
  const value = body.Valute?.USD?.Value;
  if (typeof value !== "number" || !(value > 0)) throw new Error("No USD rate in the feed");
  return value;
};

let source: RateSource = fromCbr;
let cached: { value: number; at: number } | null = null;

/** Tests and other hosts replace the Central Bank with their own rate. */
export function setRateSource(next: RateSource | undefined): void {
  source = next ?? fromCbr;
  cached = null;
}

export async function usdRub(): Promise<number> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  try {
    cached = { value: Number((await source()).toFixed(4)), at: Date.now() };
    return cached.value;
  } catch {
    return cached?.value ?? FALLBACK;
  }
}

/** Dollars per one unit of the currency. */
export async function usdPer(currency: "USD" | "RUB"): Promise<number> {
  return currency === "RUB" ? 1 / (await usdRub()) : 1;
}
