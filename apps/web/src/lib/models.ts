import type { ModelInfo, ProviderError } from "@artel/shared";
import type { Api } from "../api";

export type ModelsResult = { models: ModelInfo[] } | { error: ProviderError };

const cache = new Map<string, Promise<ModelsResult>>();

/** Model list of a provider, shared by the picker and the providers screen. Never rejects. */
export function loadModels(api: Api, providerId: string, fresh = false): Promise<ModelsResult> {
  const hit = cache.get(providerId);
  if (hit && !fresh) return hit;
  const pending = api.providers[":id"].models
    .$get({ param: { id: providerId }, query: fresh ? { fresh: "1" } : {} })
    .then(async (res): Promise<ModelsResult> => {
      const body = (await res.json()) as unknown;
      if (res.ok) return { models: body as ModelInfo[] };
      return { error: (body as { error?: ProviderError }).error ?? { code: "unknown" } };
    })
    .catch((): ModelsResult => ({ error: { code: "unknown" } }));
  cache.set(providerId, pending);
  // A failed check should not stick: the next look retries.
  void pending.then((r) => {
    if ("error" in r && cache.get(providerId) === pending) cache.delete(providerId);
  });
  return pending;
}

export function forgetModels(providerId: string): void {
  cache.delete(providerId);
}
