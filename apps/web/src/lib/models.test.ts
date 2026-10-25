import type { ModelInfo } from "@drimvox/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../api";
import { dropStoredModels, loadModels, storedModels } from "./models";

const model: ModelInfo = { id: "m1", name: "Model 1", contextLength: null, priceIn: 1, priceOut: 2, priceEstimated: false, tools: true, vision: false };

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());

// Seen: the picker waited for the list every time it opened; a list kept from the last time shows at once.
describe("a provider's model list kept between starts", () => {
  it("is kept once loaded, and goes with the provider", async () => {
    const api = { providers: { ":id": { models: { $get: async () => new Response(JSON.stringify([model]), { status: 200 }) } } } } as unknown as Api;
    expect(storedModels("p1")).toBeNull();
    await loadModels(api, "p1", true);
    expect(storedModels("p1")).toEqual([model]);
    dropStoredModels("p1");
    expect(storedModels("p1")).toBeNull();
  });

  it("is not shown when it is old", () => {
    localStorage.setItem("drimvox.models.p2", JSON.stringify({ at: Date.now() - 8 * 24 * 60 * 60_000, models: [model] }));
    expect(storedModels("p2")).toBeNull();
  });
});
