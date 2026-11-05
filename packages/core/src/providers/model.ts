import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible, type MetadataExtractor } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Connection } from "./repo";

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
    fetch: conn.preset === "ollama" || conn.preset === "lmstudio" ? withoutEffort(fetch ?? globalThis.fetch) : fetch,
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
    return cost === undefined ? undefined : { drimvox: { billed: cost } };
  },
  createStreamExtractor: () => {
    let cost: number | undefined;
    return {
      processChunk: (chunk) => {
        cost = billOf(chunk) ?? cost;
      },
      buildMetadata: () => (cost === undefined ? undefined : { drimvox: { billed: cost } }),
    };
  },
};
