import type { Balance, PresetId } from "@artel/shared";
import { fetchJson } from "./http";

/** Remaining money on the account, where the provider exposes it. Null when it does not. */
export async function fetchBalance(preset: PresetId, baseUrl: string, apiKey: string | null): Promise<Balance | null> {
  if (preset === "openrouter" || preset === "routerai") {
    // RouterAI answers like OpenRouter, in rubles.
    const body = (await fetchJson(`${baseUrl}/credits`, apiKey)) as {
      data?: { total_credits?: number; total_usage?: number; credits?: number; balance?: number };
      balance?: number;
    };
    const currency = preset === "routerai" ? "RUB" : "USD";
    const credits = body.data?.total_credits;
    const usage = body.data?.total_usage;
    if (typeof credits === "number" && typeof usage === "number") return { amount: round(credits - usage), currency };
    // RouterAI: what is left, as `data.credits`.
    const left = body.data?.credits ?? body.data?.balance ?? body.balance;
    return typeof left === "number" ? { amount: round(left), currency } : null;
  }
  if (preset === "deepseek") {
    const body = (await fetchJson(`${new URL(baseUrl).origin}/user/balance`, apiKey)) as {
      balance_infos?: { currency?: string; total_balance?: string }[];
    };
    const infos = (body.balance_infos ?? [])
      .map((i) => ({ currency: i.currency ?? "", amount: Number(i.total_balance) }))
      .filter((i) => i.currency && Number.isFinite(i.amount));
    // Money sits in the currency it was topped up in; prefer dollars only when they are there.
    const funded = infos.filter((i) => i.amount > 0);
    const info =
      funded.find((i) => i.currency === "USD") ??
      funded.sort((a, b) => b.amount - a.amount)[0] ??
      infos.find((i) => i.currency === "USD") ??
      infos[0];
    return info ? { amount: round(info.amount), currency: info.currency } : null;
  }
  return null;
}

function round(n: number): number {
  return Number(n.toFixed(6));
}
