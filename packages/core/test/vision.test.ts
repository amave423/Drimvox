import type { ModelInfo } from "@drimvox/shared";
import { describe, expect, it } from "vitest";
import type { Connection } from "../src/providers/repo";
import { resolveVision } from "../src/visual/look";

const model = (id: string, vision: boolean | null, priceIn: number | null): ModelInfo => ({
  id,
  name: id,
  contextLength: null,
  priceIn,
  priceOut: null,
  priceEstimated: false,
  tools: true,
  vision,
});
const conn = { id: "ds", preset: "deepseek" } as unknown as Connection;
const providers = { connection: (id: string) => (id === "ds" ? conn : null) };
const models = [model("deepseek-v4-pro", false, 1.32), model("deepseek-flash", true, 0.3), model("deepseek-image", true, 0.1)];
const find = async (_c: Connection, id: string) => models.find((m) => m.id === id);
const list = async () => models;

// Seen live: DeepSeek V4 Pro built a whole service and nobody looked at its pages, though DeepSeek Flash on the same key sees.
describe("who looks at pages", () => {
  it("is the model the settings name", async () => {
    expect((await resolveVision({ providerId: "ds", model: "deepseek-v4-pro" }, providers, { providerId: "ds", model: "deepseek-flash" }, find, list))?.model).toBe("deepseek-v4-pro");
  });

  it("is the task's own model when it sees", async () => {
    expect((await resolveVision(null, providers, { providerId: "ds", model: "deepseek-flash" }, find, list))?.model).toBe("deepseek-flash");
  });

  it("is the cheapest seeing model of the same provider when the task's own is blind, never a picture maker", async () => {
    expect((await resolveVision(null, providers, { providerId: "ds", model: "deepseek-v4-pro" }, find, list))?.model).toBe("deepseek-flash");
  });

  it("is nobody when no model of the provider sees", async () => {
    expect(await resolveVision(null, providers, { providerId: "ds", model: "deepseek-v4-pro" }, find, async () => [models[0]!])).toBeNull();
  });

  // Seen live: a chain of free models has no models of its own, and nobody looked at the pages of a project it worked.
  it("is another provider's free seeing model when the task's own provider has none", async () => {
    const chain = { id: "chain", preset: "custom", chain: {} } as unknown as Connection;
    const paid = { id: "paid", preset: "openai" } as unknown as Connection;
    const gratis = { id: "free", preset: "openrouter" } as unknown as Connection;
    const all = { chain, paid, free: gratis } as Record<string, Connection>;
    const many = { connection: (id: string) => all[id] ?? null, list: () => Object.keys(all).map((id) => ({ id })) };
    const lists: Record<string, ModelInfo[]> = {
      chain: [model("auto-code", null, 0)],
      paid: [model("gpt-vision", true, 0.1)],
      free: [{ ...model("gemma-vision:free", true, 0), priceOut: 0 }, model("text-only:free", false, 0)],
    };
    const found = await resolveVision(null, many, { providerId: "chain", model: "auto-code" }, async () => undefined, async (c) => lists[c.id] ?? []);
    expect(found).toMatchObject({ model: "gemma-vision:free" });
    expect(found?.conn.id).toBe("free");
    lists.free = [];
    expect((await resolveVision(null, many, { providerId: "chain", model: "auto-code" }, async () => undefined, async (c) => lists[c.id] ?? []))?.model).toBe("gpt-vision");
  });
});
