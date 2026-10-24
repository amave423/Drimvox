import type { ModelInfo } from "@drimvox/shared";
import type { Connection } from "./repo";

/**
 * Below this many parameters a model calls tools badly: seen live, llama3.2:3b answered a greeting by writing a search
 * call as text. Such models chat without tools even when Ollama says they have them.
 */
export const MIN_TOOL_PARAMS = 3_500_000_000;

/** Ollama's /v1/models says nothing about a model; /api/show tells whether it calls tools, sees pictures and how much it reads. */
export async function withOllamaDetails(conn: Connection, models: ModelInfo[]): Promise<ModelInfo[]> {
  const root = conn.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  return Promise.all(
    models.map(async (m) => {
      try {
        const res = await conn.fetch(`${root}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: m.id }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return m;
        const details = (await res.json()) as { capabilities?: string[]; model_info?: Record<string, unknown> };
        const caps = details.capabilities ?? [];
        const info = details.model_info ?? {};
        const params = typeof info["general.parameter_count"] === "number" ? info["general.parameter_count"] : null;
        const arch = info["general.architecture"];
        const context = typeof arch === "string" ? info[`${arch}.context_length`] : undefined;
        return {
          ...m,
          tools: caps.includes("tools") && (params === null || params >= MIN_TOOL_PARAMS),
          vision: caps.includes("vision"),
          contextLength: typeof context === "number" ? context : m.contextLength,
        };
      } catch {
        return m;
      }
    }),
  );
}
