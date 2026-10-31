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
    fetch,
    headers: conn.preset === "openrouter" ? { "X-Title": "Drimvox" } : undefined,
    metadataExtractor: billed,
  });
  return provider.chatModel(modelId);
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
