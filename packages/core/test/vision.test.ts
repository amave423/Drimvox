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
});
