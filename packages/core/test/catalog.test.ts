import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { fetchBalance } from "../src/providers/balance";
import { normalizeModels } from "../src/providers/catalog";
import { costOf } from "../src/providers/pricing";
import { createCipher } from "../src/secrets";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

let fake: FakeProvider | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("normalizeModels", () => {
  // Seen on RouterAI: models that cost nothing per token but money per request; they must not look free.
  it("does not take a model paid per request for a free one", () => {
    const [free, perRequest] = normalizeModels("openrouter", [
      { id: "perplexity/sonar-search", pricing: { prompt: "0", completion: "0", request: "0.05" } },
      { id: "liquid/lfm-2.5-2.6b:free", pricing: { prompt: "0", completion: "0", request: "0" } },
    ]);
    expect([perRequest!.priceIn, perRequest!.priceOut]).toEqual([null, null]);
    expect([free!.priceIn, free!.priceOut]).toEqual([0, 0]);
  });

  it("reads OpenRouter prices, context and tool support", () => {
    const [model] = normalizeModels("openrouter", [
      {
        id: "deepseek/deepseek-chat",
        name: "DeepSeek: V3",
        context_length: 163840,
        pricing: { prompt: "0.0000003", completion: "0.00000088" },
        supported_parameters: ["tools", "temperature"],
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      },
    ]);
    expect(model).toEqual({
      id: "deepseek/deepseek-chat",
      name: "DeepSeek: V3",
      contextLength: 163840,
      priceIn: 0.3,
      priceOut: 0.88,
      priceEstimated: false,
      tools: true,
      vision: true,
    });
  });

  it("reads the price of input the provider serves from its cache", () => {
    const [model] = normalizeModels("openrouter", [
      { id: "a/b", name: "B", pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" } },
    ]);
    expect(model).toMatchObject({ priceIn: 1, priceOut: 2, priceCacheRead: 0.1 });
  });

  // Seen: DeepSeek's own API lists what a model takes at the top level, not under "architecture" as OpenRouter does, and
  // V4.1 Flash, which sees pictures, was taken for a model that does not.
  it("reads what a model takes from DeepSeek's own list, where it stands at the top level", () => {
    const models = normalizeModels("deepseek", [
      { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", input_modalities: ["text", "image"], output_modalities: ["text"] },
      { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", input_modalities: ["text"], output_modalities: ["text"] },
    ]);
    expect(models.find((m) => m.id === "deepseek-flash")).toMatchObject({ vision: true });
    expect(models.find((m) => m.id === "deepseek-v4-pro")).toMatchObject({ vision: false });
  });

  it("uses the built-in price table for DeepSeek and marks it as an estimate", () => {
    const [model] = normalizeModels("deepseek", [{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", context_window: 1048576 }]);
    expect(model).toMatchObject({ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", contextLength: 1048576, priceEstimated: true });
    expect(model?.priceIn).toBeGreaterThan(0);
    // From api-docs.deepseek.com/quick_start/pricing: a cache hit costs a fiftieth of a miss.
    expect(model).toMatchObject({ priceIn: 0.3, priceOut: 1.2, priceCacheRead: 0.006 });
  });

  it("leaves NVIDIA models that cannot chat out of the list", () => {
    const ids = normalizeModels("nvidia", [
      { id: "moonshotai/kimi-k3" },
      { id: "nvidia/nv-embedqa-mistral-7b-v2" },
      { id: "nvidia/llama-3.1-nemoguard-8b-content-safety" },
      { id: "nvidia/nemotron-4-340b-reward" },
      { id: "nvidia/nemotron-parse" },
      { id: "nvidia/nvclip" },
      { id: "nvidia/ai-synthetic-video-detector" },
      { id: "z-ai/glm-5.3-flash" },
    ]).map((m) => m.id);
    expect(ids).toEqual(["moonshotai/kimi-k3", "z-ai/glm-5.3-flash"]);
  });

  // Seen live: OpenRouter lists Lyria (music) and a safety classifier among its free models; a chat with them fails.
  it("leaves out models that make music or sound, judge safety or rank search results", () => {
    const ids = normalizeModels("openrouter", [
      { id: "google/lyria-3-pro-preview", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text", "audio"] } },
      { id: "nvidia/nemotron-3.5-content-safety:free", pricing: { prompt: "0", completion: "0" } },
      { id: "meta-llama/llama-guard-4-12b", pricing: { prompt: "0.0000002", completion: "0.0000002" } },
      { id: "cohere/rerank-4-fast", pricing: { prompt: "0", completion: "0" } },
      { id: "nvidia/nemotron-3-super-120b-a12b:free", pricing: { prompt: "0", completion: "0" } },
      { id: "openai/gpt-4o-audio-preview", pricing: { prompt: "0.0000025", completion: "0.00001" }, architecture: { output_modalities: ["text", "audio"] } },
    ]).map((m) => m.id);
    expect(ids).toEqual(["nvidia/nemotron-3-super-120b-a12b:free"]);
  });

  // Seen: Gemini "-image", Nano Banana and GPT-5 Image were in the text list as well as on the Pictures tab.
  it("leaves picture makers that also write text to the Pictures tab", () => {
    const ids = normalizeModels("openrouter", [
      { id: "google/gemini-3-pro-image", architecture: { output_modalities: ["image", "text"] } },
      { id: "openai/gpt-5-image", architecture: { output_modalities: ["image", "text"] } },
      { id: "minimax/minimax-m3", architecture: { output_modalities: ["text"] } },
    ]).map((m) => m.id);
    expect(ids).toEqual(["minimax/minimax-m3"]);
  });

  // Google's OpenAI-style address lists "models/gemini-…" and documents the name without "models/" for requests.
  it("names Google's models the way its chat requests take them", () => {
    expect(normalizeModels("custom", [{ id: "models/gemini-3-flash", object: "model" }]).map((m) => m.id)).toEqual(["gemini-3-flash"]);
  });

  it("prices local models at zero", () => {
    expect(normalizeModels("ollama", [{ id: "qwen3:8b" }])[0]).toMatchObject({ priceIn: 0, priceOut: 0 });
  });

  it("prices NVIDIA models at zero: they run on free developer credits", () => {
    expect(normalizeModels("nvidia", [{ id: "moonshotai/kimi-k3" }])[0]).toMatchObject({ priceIn: 0, priceOut: 0 });
  });

  it("leaves prices unknown when the provider does not publish them", () => {
    expect(normalizeModels("custom", [{ id: "some/model" }])[0]).toMatchObject({
      priceIn: null,
      priceOut: null,
      tools: null,
    });
  });

  it("sorts by name and drops entries without an id", () => {
    const models = normalizeModels("custom", [{ id: "b" }, { name: "no id" }, { id: "a" }]);
    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("costOf", () => {
  const model = { id: "m", name: "M", contextLength: null, priceIn: 1, priceOut: 2, priceEstimated: false, tools: true, vision: null };
  const monday = new Date("2026-10-12T07:00:00Z");

  it("counts input from the provider's cache at the cache price", () => {
    expect(costOf({ ...model, priceCacheRead: 0.1 }, "openrouter", { input: 1000, cacheRead: 800, output: 100 }, monday)).toBeCloseTo(0.00048, 12);
  });

  it("counts cached input at the full price when the cache price is unknown", () => {
    expect(costOf(model, "openrouter", { input: 1000, cacheRead: 800, output: 100 }, monday)).toBeCloseTo(0.0012, 12);
  });

  it("halves DeepSeek outside its peak hours", () => {
    const usage = { input: 1000, cacheRead: 0, output: 1000 };
    expect(costOf(model, "deepseek", usage, monday)).toBeCloseTo(0.003, 12);
    expect(costOf(model, "deepseek", usage, new Date("2026-10-12T12:00:00Z"))).toBeCloseTo(0.0015, 12);
    expect(costOf(model, "deepseek", usage, new Date("2026-10-17T07:00:00Z"))).toBeCloseTo(0.0015, 12);
  });

  it("is unknown without a price", () => {
    expect(costOf(undefined, "openrouter", { input: 1, cacheRead: 0, output: 1 })).toBeNull();
  });
});

describe("fetchBalance", () => {
  it("reads OpenRouter credits minus usage", async () => {
    fake = await startFakeProvider({ routes: { "/v1/credits": { data: { total_credits: 10, total_usage: 2.5 } } } });
    expect(await fetchBalance("openrouter", fake.baseUrl, "k")).toEqual({ amount: 7.5, currency: "USD" });
  });

  it("reads the DeepSeek balance in dollars", async () => {
    fake = await startFakeProvider({
      routes: {
        "/user/balance": {
          is_available: true,
          balance_infos: [
            { currency: "CNY", total_balance: "70.00" },
            { currency: "USD", total_balance: "4.20" },
          ],
        },
      },
    });
    expect(await fetchBalance("deepseek", fake.baseUrl, "k")).toEqual({ amount: 4.2, currency: "USD" });
  });

  it("shows the DeepSeek balance in the currency that actually holds money", async () => {
    fake = await startFakeProvider({
      routes: {
        "/user/balance": {
          is_available: true,
          balance_infos: [
            { currency: "CNY", total_balance: "19.51" },
            { currency: "USD", total_balance: "0.00" },
          ],
        },
      },
    });
    expect(await fetchBalance("deepseek", fake.baseUrl, "k")).toEqual({ amount: 19.51, currency: "CNY" });
  });

  it("has no balance for providers without such an API", async () => {
    expect(await fetchBalance("nvidia", "https://integrate.api.nvidia.com/v1", "k")).toBeNull();
  });
});

describe("secrets", () => {
  it("round-trips and never stores plain text", () => {
    const cipher = createCipher(randomBytes(32));
    const blob = cipher.encrypt("sk-secret");
    expect(blob).not.toContain("sk-secret");
    expect(cipher.decrypt(blob)).toBe("sk-secret");
  });

  it("refuses to decrypt with another key", () => {
    const blob = createCipher(randomBytes(32)).encrypt("sk-secret");
    expect(() => createCipher(randomBytes(32)).decrypt(blob)).toThrow();
  });

  it("refuses a key of the wrong size", () => {
    expect(() => createCipher(randomBytes(16))).toThrow();
  });
});
