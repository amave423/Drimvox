import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Connection } from "./repo";

/** Every supported provider speaks the OpenAI chat API, so one adapter covers them all. */
export function languageModel(conn: Connection, modelId: string): LanguageModel {
  const provider = createOpenAICompatible({
    name: conn.preset,
    baseURL: conn.baseUrl,
    apiKey: conn.apiKey ?? undefined,
    includeUsage: true,
    headers: conn.preset === "openrouter" ? { "X-Title": "Artel" } : undefined,
  });
  return provider.chatModel(modelId);
}
