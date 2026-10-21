import type { Availability, ModelInfo, ProviderErrorCode } from "@artel/shared";
import { presets } from "@artel/shared";
import { isCli } from "../cli/kinds";
import { NATIVE } from "./native";
import type { Connection } from "./repo";

/**
 * Whether a free model answers. Providers list models they no longer serve (seen live: 43 of NVIDIA's 59 answered
 * 404) and free ones are often busy or closed to the key (OpenRouter: 429, 403). Drimvox asks each free model a word
 * and remembers the answer for a while; a chat's own errors teach it too. Paid models are never asked.
 */
const REMEMBER: Record<Availability, number> = { ok: 60 * 60_000, busy: 10 * 60_000, gone: 12 * 60 * 60_000 };
const PROBE_MS = 25_000;
const AT_ONCE = 4;

const seen = new Map<string, { state: Availability; at: number }>();
const key = (conn: Connection, model: string) => `${conn.cacheKey}|${model}`;

export function noteAvailability(conn: Connection, model: string, state: Availability): void {
  seen.set(key(conn, model), { state, at: Date.now() });
}

export function availabilityOf(conn: Connection, model: string): Availability | undefined {
  const hit = seen.get(key(conn, model));
  if (!hit) return undefined;
  if (Date.now() - hit.at > REMEMBER[hit.state]) {
    seen.delete(key(conn, model));
    return undefined;
  }
  return hit.state;
}

/** What a chat's error says about the model itself; null when it says nothing (a wrong key, no money, a lost network). */
export function availabilityFromError(code: ProviderErrorCode): Availability | null {
  if (code === "model_not_found" || code === "forbidden") return "gone";
  if (code === "rate_limited" || code === "overloaded" || code === "timeout") return "busy";
  return null;
}

/**
 * Providers whose free models Drimvox can ask: OpenAI-style APIs on the internet, and Google, whose free tier costs a key
 * without billing nothing (seen: it lists models it no longer serves to new users).
 */
export function canCheck(conn: Connection): boolean {
  if (conn.preset === "google") return true;
  return !isCli(conn.preset) && !NATIVE.includes(conn.preset) && presets[conn.preset].billing !== "free";
}

/** A model worth asking: free, or on Google's free tier. */
const isFreeModel = (conn: Connection, m: ModelInfo) => (conn.preset === "google" ? m.freeTier === true : m.priceIn === 0 && m.priceOut === 0);

/** The models with what Drimvox knows of them. */
export function withAvailability(conn: Connection, models: ModelInfo[]): ModelInfo[] {
  return models.map((m) => {
    const available = availabilityOf(conn, m.id);
    return available ? { ...m, available } : m;
  });
}

/** Asks every free model it does not remember; a few at a time. */
export async function checkFree(conn: Connection, models: ModelInfo[]): Promise<Record<string, Availability>> {
  const free = canCheck(conn) ? models.filter((m) => isFreeModel(conn, m)) : [];
  const states: Record<string, Availability> = {};
  const queue = free.filter((m) => {
    const known = availabilityOf(conn, m.id);
    if (known) states[m.id] = known;
    return !known;
  });
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const state = await probe(conn, m.id);
      if (state) {
        noteAvailability(conn, m.id, state);
        states[m.id] = state;
      }
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  return states;
}

/** One word from the model. Null when the answer says nothing about the model (a wrong key, a blocked country). */
async function probe(conn: Connection, model: string): Promise<Availability | null> {
  try {
    const res =
      conn.preset === "google"
        ? await conn.fetch(`${conn.baseUrl}/models/${model}:generateContent`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": conn.apiKey ?? "" },
            body: JSON.stringify({ contents: [{ parts: [{ text: "Hi" }] }], generationConfig: { maxOutputTokens: 1 } }),
            signal: AbortSignal.timeout(PROBE_MS),
          })
        : await conn.fetch(`${conn.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}) },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }], max_tokens: 16, stream: false }),
            signal: AbortSignal.timeout(PROBE_MS),
          });
    const body = await res.text().catch(() => "");
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 402 || /location is not supported|unsupported_country/i.test(body)) return null;
    if (res.status === 429 || res.status >= 500) return "busy";
    return "gone";
  } catch {
    // No answer in time: a queue, most often.
    return "busy";
  }
}
