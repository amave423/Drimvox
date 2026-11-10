import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible, type MetadataExtractor } from "@ai-sdk/openai-compatible";
import type { JSONValue, LanguageModel } from "ai";
import type { Connection } from "./repo";
import { withCheapestProvider } from "./routing";

/**
 * Anthropic, OpenAI and Google go through their own SDK packages, so tools, reasoning and pictures work as
 * the vendor designed them. Everyone else, xAI included, speaks the OpenAI chat API.
 */
export function languageModel(conn: Connection, modelId: string): LanguageModel {
  const apiKey = conn.apiKey ?? undefined;
  // Straight or through the provider's proxy.
  const fetch = conn.fetch;
  // A chain of free models answers as one model (docs/specs/model-chains.md).
  if (conn.chain) return conn.chain.model(modelId) as LanguageModel;
  if (conn.preset === "anthropic") return createAnthropic({ apiKey, baseURL: conn.baseUrl, fetch }).languageModel(modelId);
  if (conn.preset === "google") return createGoogleGenerativeAI({ apiKey, baseURL: conn.baseUrl, fetch }).languageModel(modelId);
  if (conn.preset === "openai") return createOpenAI({ apiKey, baseURL: conn.baseUrl, fetch }).chat(modelId);
  const provider = createOpenAICompatible({
    name: conn.preset,
    baseURL: conn.baseUrl,
    apiKey,
    includeUsage: true,
    fetch: withoutHistoryReasoning(
      conn.preset === "ollama" || conn.preset === "lmstudio"
        ? withoutEffort(fetch ?? globalThis.fetch)
        : // Behind RouterAI and OpenRouter one model has many providers: the cheapest one, kept, so its cache holds.
          conn.preset === "routerai" || conn.preset === "openrouter"
          ? withCheapestProvider(conn.baseUrl, fetch ?? globalThis.fetch)
          : (fetch ?? globalThis.fetch),
    ),
    headers: conn.preset === "openrouter" ? { "X-Title": "Drimvox" } : undefined,
    metadataExtractor: billed,
  });
  return provider.chatModel(modelId);
}

/**
 * A local model's request asked again without its thinking level when the model refuses that level. Seen live: a
 * Qwen 3.8 template took "none", "low" and "medium" and failed on "high" ("Supported types are xhigh, medium, and low");
 * a model that does not think at all refuses any level. Without one, the model thinks its own way.
 */
export function withoutEffort(fetchFn: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await fetchFn(input, init);
    if (res.ok || typeof init?.body !== "string" || !init.body.includes('"reasoning_effort"')) return res;
    const said = await res.clone().text().catch(() => "");
    if (!/reasoning|think/i.test(said)) return res;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    delete body.reasoning_effort;
    return fetchFn(input, { ...init, body: JSON.stringify(body) });
  };
}

/**
 * A request asked again without the earlier answers' reasoning when the provider refuses it. Seen live: a chain went
 * from DeepSeek to another provider in the middle of a project, and every request failed with "'messages.2': property
 * 'reasoning_content' is unsupported" (DeepSeek's thinking travels with the history; others do not take it).
 */
export function withoutHistoryReasoning(fetchFn: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await fetchFn(input, init);
    if (res.ok || typeof init?.body !== "string" || !init.body.includes('"reasoning_content"')) return res;
    const said = await res.clone().text().catch(() => "");
    if (!/reasoning_content/.test(said)) return res;
    const body = JSON.parse(init.body) as { messages?: Record<string, unknown>[] };
    for (const m of body.messages ?? []) delete m.reasoning_content;
    return fetchFn(input, { ...init, body: JSON.stringify(body) });
  };
}

/** `usage.cost`: what the request cost in the account's currency, as OpenRouter and RouterAI send it. */
function billOf(body: unknown): number | undefined {
  const cost = (body as { usage?: { cost?: unknown } } | null)?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/**
 * The provider's own bill for a request, kept as `providerMetadata.drimvox.billed`. Seen live: by the catalog's prices
 * Drimvox counted 126 ₽ where RouterAI took 80 ₽ (its cache costs less than its catalog says).
 */
const billed: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => {
    const cost = billOf(parsedBody);
    return cost === undefined ? undefined : { drimvox: { billed: cost, usage: usageOf(parsedBody) } };
  },
  createStreamExtractor: () => {
    let cost: number | undefined;
    let usage: JSONValue | undefined;
    return {
      processChunk: (chunk) => {
        cost = billOf(chunk) ?? cost;
        usage = usageOf(chunk) ?? usage;
      },
      buildMetadata: () => (cost === undefined ? undefined : { drimvox: { billed: cost, usage } }),
    };
  },
};

/** The provider's own usage object as sent, for the step trace (how it counts cache, thinking and the bill). */
function usageOf(body: unknown): JSONValue | undefined {
  return ((body as { usage?: JSONValue } | null)?.usage ?? undefined) as JSONValue | undefined;
}
