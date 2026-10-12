import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Connection } from "./repo";

/**
 * Anthropic, OpenAI and Google go through their own SDK packages, so tools, reasoning and pictures work as
 * the vendor designed them. Everyone else, xAI included, speaks the OpenAI chat API.
 */
export function languageModel(conn: Connection, modelId: string): LanguageModel {
  const apiKey = conn.apiKey ?? undefined;
  if (conn.preset === "anthropic") return createAnthropic({ apiKey, baseURL: conn.baseUrl }).languageModel(modelId);
  if (conn.preset === "google") return createGoogleGenerativeAI({ apiKey, baseURL: conn.baseUrl }).languageModel(modelId);
  if (conn.preset === "openai") return createOpenAI({ apiKey, baseURL: conn.baseUrl }).chat(modelId);
  const provider = createOpenAICompatible({
    name: conn.preset,
    baseURL: conn.baseUrl,
    apiKey,
    includeUsage: true,
    headers: conn.preset === "openrouter" ? { "X-Title": "Artel" } : undefined,
  });
  return provider.chatModel(modelId);
}
