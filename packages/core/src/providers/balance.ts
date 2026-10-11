import type { Balance, PresetId } from "@artel/shared";
import { fetchJson } from "./http";

/** Remaining money on the account, where the provider exposes it. Null when it does not. */
export async function fetchBalance(preset: PresetId, baseUrl: string, apiKey: string | null): Promise<Balance | null> {
  if (preset === "openrouter") {
    const body = (await fetchJson(`${baseUrl}/credits`, apiKey)) as { data?: { total_credits?: number; total_usage?: number } };
    const credits = body.data?.total_credits;
    const usage = body.data?.total_usage;
    if (typeof credits !== "number" || typeof usage !== "number") return null;
    return { amount: round(credits - usage), currency: "USD" };
  }
  if (preset === "deepseek") {
    const body = (await fetchJson(`${new URL(baseUrl).origin}/user/balance`, apiKey)) as {
      balance_infos?: { currency?: string; total_balance?: string }[];
    };
    const infos = body.balance_infos ?? [];
    const info = infos.find((i) => i.currency === "USD") ?? infos[0];
    const amount = Number(info?.total_balance);
    if (!info?.currency || !Number.isFinite(amount)) return null;
    return { amount: round(amount), currency: info.currency };
  }
  return null;
}

function round(n: number): number {
  return Number(n.toFixed(6));
}
