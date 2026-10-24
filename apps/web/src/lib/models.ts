import type { ModelInfo, ProviderError } from "@drimvox/shared";
import type { Api } from "../api";

export type ModelsResult = { models: ModelInfo[] } | { error: ProviderError };

const cache = new Map<string, Promise<ModelsResult>>();

/** Lists kept between starts, so the picker shows them at once (seen: waiting for the list each time the picker opened). */
const STORED = "drimvox.models.";
/** A kept list older than this is not shown: models and prices change. */
const STORED_MAX_MS = 7 * 24 * 60 * 60_000;

/** The list kept from the last time, if there is a recent one; it is shown while the fresh one comes. */
export function storedModels(providerId: string): ModelInfo[] | null {
  try {
    const kept = JSON.parse(localStorage.getItem(STORED + providerId) ?? "null") as { at: number; models: ModelInfo[] } | null;
    return kept && Date.now() - kept.at < STORED_MAX_MS && Array.isArray(kept.models) ? kept.models : null;
  } catch {
    return null;
  }
}

function store(providerId: string, models: ModelInfo[]): void {
  try {
    localStorage.setItem(STORED + providerId, JSON.stringify({ at: Date.now(), models }));
  } catch {
    // Too big or no storage: the list is asked for again next time.
  }
}

/** Every provider's list asked for in the background at start, so the picker has it when opened. */
export function preloadModels(api: Api, providers: { id: string; billing: string }[]): void {
  // Programs on a subscription build their list each time from their last run.
  for (const p of providers) if (p.billing !== "subscription") void loadModels(api, p.id);
}

/** Model list of a provider, shared by the picker and the providers screen. Never rejects. */
export function loadModels(api: Api, providerId: string, fresh = false): Promise<ModelsResult> {
  const hit = cache.get(providerId);
  if (hit && !fresh) return hit;
  const pending = api.providers[":id"].models
    .$get({ param: { id: providerId }, query: fresh ? { fresh: "1" } : {} })
    .then(async (res): Promise<ModelsResult> => {
      const body = (await res.json()) as unknown;
      if (res.ok) {
        store(providerId, body as ModelInfo[]);
        return { models: body as ModelInfo[] };
      }
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

const checking = new Map<string, Promise<ModelsResult>>();

/**
 * Asks the provider's free models a word each, once per list, and adds what came back: the picker hides the ones that
 * are gone and marks the busy ones. Paid models are never asked. Never rejects.
 */
export function checkFree(api: Api, providerId: string, result: ModelsResult): Promise<ModelsResult> {
  if ("error" in result || !result.models.some((m) => isFree(m) && !m.available)) return Promise.resolve(result);
  const running = checking.get(providerId);
  if (running) return running;
  const pending = api.providers[":id"].models.check
    .$post({ param: { id: providerId } })
    .then(async (res): Promise<ModelsResult> => {
      if (!res.ok) return result;
      const states = (await res.json()) as Record<string, ModelInfo["available"]>;
      const checked = { models: result.models.map((m) => (states[m.id] ? { ...m, available: states[m.id] } : m)) };
      cache.set(providerId, Promise.resolve(checked));
      store(providerId, checked.models);
      return checked;
    })
    .catch(() => result)
    .finally(() => checking.delete(providerId));
  checking.set(providerId, pending);
  return pending;
}

export function forgetModels(providerId: string): void {
  cache.delete(providerId);
}

/** A provider removed: its kept list goes too. */
export function dropStoredModels(providerId: string): void {
  forgetModels(providerId);
  try {
    localStorage.removeItem(STORED + providerId);
  } catch {
    // Nothing kept.
  }
}

/** A model that costs nothing per token on a provider that charges for others. */
export function isFree(model: Pick<ModelInfo, "priceIn" | "priceOut">): boolean {
  return model.priceIn === 0 && model.priceOut === 0;
}

/**
 * A list split into free models and the rest, free first, when it has both; otherwise one group. Free models stay among
 * their own kind (text, pictures), so it is still clear what each one does.
 */
export function freeFirst<T>(items: T[], free: (item: T) => boolean): { free: T[]; paid: T[] } | null {
  const freeOnes = items.filter(free);
  if (freeOnes.length === 0 || freeOnes.length === items.length) return null;
  return { free: freeOnes, paid: items.filter((i) => !free(i)) };
}
