/**
 * One provider for a model behind RouterAI or OpenRouter, the cheapest (asked for, whatever its country). Seen live:
 * with no choice of ours RouterAI spread one conversation over its 48 providers of DeepSeek 1017, priced 0.71 to
 * 269 ₽ per million input tokens, each with a cache of its own: steps cost up to seven times one another, and the cache
 * was lost whenever the next step went elsewhere. Both list a model's providers (GET /models/{id}/endpoints) and take
 * `provider.order`; the fallbacks stay allowed, so a provider that is down does not stop the work.
 */

interface Endpoint {
  tag?: string;
  status?: number;
  supported_parameters?: string[];
  pricing?: { prompt?: number | string; completion?: number | string; input_cache_read?: number | string };
}

/**
 * An agent's tokens, measured on a site built by DeepSeek 1017: 15 % of the input new, 81 % read from the cache, 4 %
 * written out. A provider is priced by what such work costs there.
 */
const SHARE = { input: 0.148, cached: 0.816, output: 0.036 };

const price = (v: number | string | undefined) => (v === undefined || v === "" ? null : Number(v));

/** The cheapest working provider that takes tools, by an agent's work; null when none is listed. */
export function cheapestEndpoint(endpoints: Endpoint[]): string | null {
  let best: { tag: string; cost: number } | null = null;
  for (const e of endpoints) {
    // "deepinfra/flex", "baseten/priority": another queue and another speed, not the model's usual service.
    if (!e.tag || e.tag.includes("/") || (e.status ?? 0) < 0) continue;
    if (e.supported_parameters && !e.supported_parameters.includes("tools")) continue;
    const input = price(e.pricing?.prompt);
    const output = price(e.pricing?.completion);
    if (input === null || output === null || !Number.isFinite(input) || !Number.isFinite(output)) continue;
    const cached = price(e.pricing?.input_cache_read) ?? input;
    const cost = SHARE.input * input + SHARE.cached * cached + SHARE.output * output;
    if (!best || cost < best.cost) best = { tag: e.tag, cost };
  }
  return best?.tag ?? null;
}

/** A model's choice is looked up again after this long: prices move with the exchange rate. */
const FRESH_MS = 6 * 3_600_000;
const chosen = new Map<string, { at: number; tag: Promise<string | null> }>();

async function choose(baseUrl: string, model: string, fetchFn: typeof fetch): Promise<string | null> {
  try {
    // "deepseek/deepseek-v4.1-flash-1017": author and name; an alias such as "~z-ai/glm-flash-latest" is listed under its name.
    const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/models/${model.replace(/^~/, "")}/endpoints`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { endpoints?: Endpoint[] } };
    return cheapestEndpoint(body.data?.endpoints ?? []);
  } catch {
    return null;
  }
}

function cheapest(baseUrl: string, model: string, fetchFn: typeof fetch): Promise<string | null> {
  const key = `${baseUrl}|${model}`;
  const known = chosen.get(key);
  if (known && Date.now() - known.at < FRESH_MS) return known.tag;
  const tag = choose(baseUrl, model, fetchFn);
  chosen.set(key, { at: Date.now(), tag });
  return tag;
}

/** Requests to the chat API go to the model's cheapest provider; a request that names its own provider is left as it is. */
export function withCheapestProvider(baseUrl: string, fetchFn: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== "string" || !/\/chat\/completions$/.test(String(input))) return fetchFn(input, init);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return fetchFn(input, init);
    }
    if (typeof body.model !== "string" || body.provider || body.model.includes("@")) return fetchFn(input, init);
    const tag = await cheapest(baseUrl, body.model, fetchFn);
    if (!tag) return fetchFn(input, init);
    return fetchFn(input, { ...init, body: JSON.stringify({ ...body, provider: { order: [tag] } }) });
  };
}
