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

/** A provider's prices per token, in the router's money: new input, input from the cache, output. */
export interface EndpointRates {
  input: number;
  cached: number;
  output: number;
}

/** The cheapest working provider that takes tools, by an agent's work; null when none is listed. */
export function cheapestEndpoint(endpoints: Endpoint[]): string | null {
  return cheapestChoices(endpoints)[0]?.tag ?? null;
}

/**
 * How many providers a request names, cheapest first. The router tries them in this order, so when the first fails the
 * next steps go to the same second one and its cache keeps working (seen live: with one name, a failure sent the steps
 * of Nexus over the router's 48 providers, each step read most of the conversation anew, and a turn cost 0.19 $
 * instead of 0.03 $).
 */
const ORDER = 3;

/** The working providers that take tools, cheapest first by an agent's work, with their prices. */
function cheapestChoices(endpoints: Endpoint[]): { tag: string; rates: EndpointRates }[] {
  const all: { tag: string; cost: number; rates: EndpointRates }[] = [];
  for (const e of endpoints) {
    // "deepinfra/flex", "baseten/priority": another queue and another speed, not the model's usual service.
    if (!e.tag || e.tag.includes("/") || (e.status ?? 0) < 0) continue;
    if (e.supported_parameters && !e.supported_parameters.includes("tools")) continue;
    const input = price(e.pricing?.prompt);
    const output = price(e.pricing?.completion);
    if (input === null || output === null || !Number.isFinite(input) || !Number.isFinite(output)) continue;
    const cached = price(e.pricing?.input_cache_read) ?? input;
    const cost = SHARE.input * input + SHARE.cached * cached + SHARE.output * output;
    all.push({ tag: e.tag, cost, rates: { input, cached, output } });
  }
  return all.sort((a, b) => a.cost - b.cost).map(({ tag, rates }) => ({ tag, rates }));
}

/** A model's choice is looked up again after this long: prices move with the exchange rate. */
const FRESH_MS = 6 * 3_600_000;
const chosen = new Map<string, { at: number; tags: Promise<string[]> }>();
/** The prices of the providers chosen for a model, in their order, once known: what its steps are billed at. */
const chosenRates = new Map<string, EndpointRates[]>();

/**
 * What a model's requests are billed at now, per token in the router's money (asked for: the rates of reading, the cache
 * and writing); null when its requests are not pinned to one provider.
 */
export function pinnedRates(baseUrl: string, model: string): EndpointRates | null {
  const key = `${baseUrl}|${model}`;
  const rates = chosenRates.get(key) ?? [];
  return ((avoided.get(key) ?? 0) > Date.now() ? rates[1] : rates[0]) ?? null;
}

async function choose(baseUrl: string, model: string, fetchFn: typeof fetch): Promise<string[]> {
  try {
    // "deepseek/deepseek-v4.1-flash-1017": author and name; an alias such as "~z-ai/glm-flash-latest" is listed under its name.
    const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/models/${model.replace(/^~/, "")}/endpoints`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { endpoints?: Endpoint[] } };
    const choices = cheapestChoices(body.data?.endpoints ?? []).slice(0, ORDER + 1);
    chosenRates.set(`${baseUrl}|${model}`, choices.map((c) => c.rates));
    return choices.map((c) => c.tag);
  } catch {
    return [];
  }
}

function cheapest(baseUrl: string, model: string, fetchFn: typeof fetch): Promise<string[]> {
  const key = `${baseUrl}|${model}`;
  const known = chosen.get(key);
  if (known && Date.now() - known.at < FRESH_MS) return known.tags;
  const tags = choose(baseUrl, model, fetchFn);
  chosen.set(key, { at: Date.now(), tags });
  return tags;
}

/** Models whose cheapest provider failed lately, by `baseUrl|model`: until when their requests go where the router sends them. */
const avoided = new Map<string, number>();

/**
 * The cheapest provider of a model stopped answering or broke off: for a while the next requests start from the second
 * cheapest, always the same one, so its cache works (seen live: four tries in a row waited two minutes each for one
 * provider of DeepSeek 1017). With no second one listed, the router picks.
 */
export function unpinCheapest(baseUrl: string, model: string, ms = 15 * 60_000): void {
  avoided.set(`${baseUrl}|${model}`, Date.now() + ms);
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
    const all = await cheapest(baseUrl, body.model, fetchFn);
    const order = ((avoided.get(`${baseUrl}|${body.model}`) ?? 0) > Date.now() ? all.slice(1) : all).slice(0, ORDER);
    if (!order.length) return fetchFn(input, init);
    const pinned = await fetchFn(input, { ...init, body: JSON.stringify({ ...body, provider: { order } }) });
    // The list does not say which providers take pictures. A screenshot goes to the cheapest one too (seen live: sent
    // where the router chose, a step cost 1.20 ₽ against 0.10 ₽, the cache missed); only if it refuses, to the router.
    if (pinned.ok || pinned.status >= 500 || pinned.status === 429 || !init.body.includes('"type":"image_url"')) return pinned;
    await pinned.body?.cancel().catch(() => {});
    return fetchFn(input, init);
  };
}
