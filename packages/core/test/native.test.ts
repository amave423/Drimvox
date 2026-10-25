import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

const KEY = "native-key";
let env: TestEnv;
let vendor: FakeProvider | undefined;
let catalog: FakeProvider;

/** OpenRouter's public catalog: where Drimvox takes the prices that vendors' own APIs do not give. */
const priced = [
  { id: "anthropic/claude-sonnet-4.5", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
  { id: "google/gemini-2.5-flash", context_length: 1048576, pricing: { prompt: "0.0000003", completion: "0.0000025" }, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
  { id: "openai/gpt-5-mini", context_length: 400000, pricing: { prompt: "0.00000025", completion: "0.000002" }, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
  { id: "x-ai/grok-4", context_length: 256000, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
];

beforeEach(async () => {
  env = createTestEnv();
  catalog = await startFakeProvider({ routes: { "/v1/models": { data: priced } } });
  env.setPresetUrl("openrouter", catalog.baseUrl);
});

afterEach(async () => {
  await env.closeAsync();
  await vendor?.close();
  await catalog.close();
  vendor = undefined;
});

const sse = (events: object[], named = false) =>
  Buffer.from(events.map((e) => `${named ? `event: ${(e as { type: string }).type}\n` : ""}data: ${JSON.stringify(e)}\n\n`).join(""));

async function connect(preset: string, base: string) {
  env.setPresetUrl(preset as never, base);
  const res = await env.call("POST", "/api/providers", { preset, apiKey: KEY });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

async function chatOnce(providerId: string, model: string) {
  const chat = await (await env.call("POST", "/api/chats", { providerId, model })).json();
  const events = await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Привет" }));
  return events.find((e) => e.type === "done").message;
}

describe("Anthropic", () => {
  it("lists models with catalog prices and answers through the Messages API", async () => {
    vendor = await startFakeProvider({
      authorized: (h) => h["x-api-key"] === KEY && !!h["anthropic-version"],
      handle: (method, path) => {
        if (method === "GET" && path === "/v1/models") {
          return { json: { data: [{ id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5", type: "model" }] } };
        }
        if (method === "POST" && path === "/v1/messages") {
          return {
            contentType: "text/event-stream",
            bytes: sse(
              [
                { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-4-5-20250929", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
                { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Привет из Claude" } },
                { type: "content_block_stop", index: 0 },
                { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
                { type: "message_stop" },
              ],
              true,
            ),
          };
        }
        return undefined;
      },
    });
    const id = await connect("anthropic", `${vendor.origin}/v1`);
    const models = await (await env.call("GET", `/api/providers/${id}/models`)).json();
    expect(models).toEqual([
      { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", contextLength: 200000, priceIn: 3, priceOut: 15, priceEstimated: true, tools: true, vision: true },
    ]);

    const answer = await chatOnce(id, "claude-sonnet-4-5-20250929");
    expect(answer).toMatchObject({ status: "done", content: "Привет из Claude", inputTokens: 10, outputTokens: 5 });
    expect(answer.costUsd).toBeCloseTo((10 * 3 + 5 * 15) / 1e6, 9);
    const sent = vendor.requests.find((r) => r.path === "/v1/messages")!;
    expect(sent.body).toMatchObject({ model: "claude-sonnet-4-5-20250929", stream: true });
  });
});

describe("Google Gemini", () => {
  it("lists only models that write text and answers through generateContent", async () => {
    vendor = await startFakeProvider({
      authorized: (h, url) => h["x-goog-api-key"] === KEY || url.searchParams.get("key") === KEY,
      handle: (method, path) => {
        if (method === "GET" && path === "/v1beta/models") {
          return {
            json: {
              models: [
                { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent", "countTokens"] },
                { name: "models/text-embedding-004", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
                // Seen live with a real key: these generate content too, but not as a chat; they had no price and showed dashes.
                ...["lyria-3.5", "gemini-3.5-transcribe", "gemini-3.8-flash-tts", "gemini-robotics-er-2-preview", "deep-research-preview-04-2026", "antigravity-preview-latest", "gemini-2.5-computer-use-preview-10-2025", "gemini-flash-latest", "gemini-pro-latest"].map((m) => ({
                  name: `models/${m}`,
                  supportedGenerationMethods: ["generateContent"],
                })),
              ],
            },
          };
        }
        if (method === "POST" && path === "/v1beta/models/gemini-2.5-flash:streamGenerateContent") {
          return {
            contentType: "text/event-stream",
            bytes: sse([
              {
                candidates: [{ content: { parts: [{ text: "Привет из Gemini" }], role: "model" }, finishReason: "STOP", index: 0 }],
                usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
              },
            ]),
          };
        }
        return undefined;
      },
    });
    const id = await connect("google", `${vendor.origin}/v1beta`);
    const models = await (await env.call("GET", `/api/providers/${id}/models`)).json();
    expect(models.map((m: any) => [m.id, m.priceIn, m.freeTier])).toEqual([["gemini-2.5-flash", 0.3, true]]);
    expect(await chatOnce(id, "gemini-2.5-flash")).toMatchObject({ status: "done", content: "Привет из Gemini", inputTokens: 8, outputTokens: 4 });
  });
});

// Seen with the user's keys: Gemini's picture models sat among the text ones, and NVIDIA's FLUX was nowhere, since its
// list of models leaves out the ones on its genai endpoints.
const PNG = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");

async function drawOnce(providerId: string, model: string, confirm = false) {
  const chat = await (await env.call("POST", "/api/chats", { providerId, model, kind: "image" })).json();
  const events = await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Кот в очках", options: { aspectRatio: "16:9" }, ...(confirm ? { confirm: true } : {}) }));
  return events.find((e) => e.type === "done").message;
}

describe("pictures from vendors' own APIs", () => {
  it("Gemini: picture models on their own tab, drawn by generateContent", async () => {
    vendor = await startFakeProvider({
      authorized: (h) => h["x-goog-api-key"] === KEY,
      handle: (method, path) => {
        if (method === "GET" && path === "/v1beta/models") {
          return {
            json: {
              models: ["gemini-2.5-flash", "gemini-2.5-flash-image", "nano-banana-pro-preview", "gemini-3.1-flash-image-preview"].map((m) => ({
                name: `models/${m}`,
                displayName: m,
                supportedGenerationMethods: ["generateContent"],
              })),
            },
          };
        }
        if (method === "POST" && path === "/v1beta/models/gemini-2.5-flash-image:generateContent") {
          return { json: { candidates: [{ content: { parts: [{ text: "Вот" }, { inlineData: { mimeType: "image/png", data: PNG } }] } }] } };
        }
        return undefined;
      },
    });
    const id = await connect("google", `${vendor.origin}/v1beta`);
    const text = await (await env.call("GET", `/api/providers/${id}/models`)).json();
    expect(text.map((m: any) => m.id)).toEqual(["gemini-2.5-flash"]);
    const images = await (await env.call("GET", `/api/providers/${id}/media-models?kind=image`)).json();
    expect(images.map((m: any) => m.id)).toEqual(["gemini-2.5-flash-image", "gemini-3.1-flash-image-preview", "nano-banana-pro-preview"]);
    // Gemini does not say what a picture costs: it waits for "Start".
    expect(await drawOnce(id, "gemini-2.5-flash-image", true)).toMatchObject({ status: "done", media: [expect.objectContaining({ mime: "image/png" })] });
    const sent = vendor.requests.find((r) => r.path.endsWith(":generateContent"))!.body as any;
    expect(sent.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" } });
  });

  it("NVIDIA: FLUX on the genai endpoints, sized for the aspect ratio", async () => {
    vendor = await startFakeProvider({
      authorized: (h) => h.authorization === `Bearer ${KEY}`,
      handle: (method, path) => {
        if (method === "GET" && path === "/v1/models") return { json: { data: [{ id: "meta/llama-3.3-70b-instruct" }] } };
        if (method === "POST" && path === "/v1/genai/black-forest-labs/flux.1-dev") return { json: { artifacts: [{ base64: PNG, finishReason: "SUCCESS" }] } };
        return undefined;
      },
    });
    const id = await connect("nvidia", `${vendor.origin}/v1`);
    const images = await (await env.call("GET", `/api/providers/${id}/media-models?kind=image`)).json();
    expect(images.map((m: any) => m.id)).toEqual(["black-forest-labs/flux.1-dev", "black-forest-labs/flux.1-schnell"]);
    expect(await drawOnce(id, "black-forest-labs/flux.1-dev")).toMatchObject({ status: "done", media: [expect.objectContaining({ mime: "image/png" })] });
    const sent = vendor.requests.find((r) => r.path.includes("/genai/"))!.body as any;
    expect(sent).toMatchObject({ prompt: "Кот в очках", width: 1344, height: 768 });
  });

  // Asked for: a way to see every model a provider lists, even the ones Drimvox does not offer.
  it("lists every model of a provider with where it is offered", async () => {
    vendor = await startFakeProvider({
      authorized: (h) => h.authorization === `Bearer ${KEY}`,
      handle: (method, path) => {
        if (method === "GET" && path === "/v1/models") return { json: { data: [{ id: "meta/llama-3.3-70b-instruct" }, { id: "nvidia/nv-embedqa-e5-v5" }] } };
        return undefined;
      },
    });
    const id = await connect("nvidia", `${vendor.origin}/v1`);
    const all = await (await env.call("GET", `/api/providers/${id}/models/all`)).json();
    expect(all.map((m: any) => [m.id, m.offered])).toEqual([
      ["black-forest-labs/flux.1-dev", "image"],
      ["black-forest-labs/flux.1-schnell", "image"],
      ["meta/llama-3.3-70b-instruct", "text"],
      ["nvidia/nv-embedqa-e5-v5", null],
    ]);
  });
});

describe("Google's free tier", () => {
  // The pricing page as of 2026-10: Flash, Flash-Lite, Gemma and 2.5 Pro have a free tier; newer Pro, Argon, Omni and
  // picture models do not. The API does not say it, so Drimvox marks it by name (seen: the user could not tell).
  it("marks the models that have a free daily limit", async () => {
    const { googleFreeTier } = await import("../src/providers/native");
    const free = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-2.5-pro", "gemma-4-31b-it", "gemini-3-flash-preview"];
    const paid = ["gemini-4-argon", "gemini-3.1-pro-preview", "gemini-omni-1.1-flash", "gemini-3.1-flash-image", "gemini-nano-banana-2.1", "gemini-3.1-pro-preview-customtools"];
    for (const id of free) expect(googleFreeTier(id), id).toBe(true);
    for (const id of paid) expect(googleFreeTier(id), id).toBe(false);
  });
});

describe("OpenAI and xAI", () => {
  for (const [preset, keep, drop, catalogPrice] of [
    ["openai", "gpt-5-mini", ["text-embedding-3-small", "whisper-1", "dall-e-3", "tts-1", "gpt-4o-realtime-preview"], 0.25],
    ["xai", "grok-4", ["grok-imagine-image", "grok-2-image-1212"], 3],
  ] as const) {
    it(`${preset}: keeps chat models and answers through chat completions`, async () => {
      vendor = await startFakeProvider({
        key: KEY,
        models: [{ id: keep }, ...drop.map((d) => ({ id: d }))],
        chunks: [{ text: `Привет из ${preset}` }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      });
      const id = await connect(preset, vendor.baseUrl);
      const models = await (await env.call("GET", `/api/providers/${id}/models`)).json();
      expect(models.map((m: any) => [m.id, m.priceIn])).toEqual([[keep, catalogPrice]]);
      expect(await chatOnce(id, keep)).toMatchObject({ status: "done", content: `Привет из ${preset}` });
      expect(vendor.requests.some((r) => r.path === "/v1/chat/completions" && r.auth === `Bearer ${KEY}`)).toBe(true);
    });
  }
});

// Seen: a custom provider (an OpenAI-style address) listed models with no prices, so nothing was counted.
describe("a provider that gives no prices", () => {
  it("gets the catalog's prices for the models it knows, as an estimate, by the model's name whatever the prefix", async () => {
    vendor = await startFakeProvider({
      key: KEY,
      models: [
        { id: "ag/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
        { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
        { id: "house-model-1", name: "House model" },
      ],
    });
    const res = await env.call("POST", "/api/providers", { preset: "custom", baseUrl: vendor.baseUrl, apiKey: KEY });
    const id = (await res.json()).id as string;
    const models = (await (await env.call("GET", `/api/providers/${id}/models`)).json()) as { id: string; priceIn: number | null; priceOut: number | null; priceEstimated: boolean; contextLength: number | null }[];
    const by = (m: string) => models.find((x) => x.id === m)!;
    expect(by("ag/claude-sonnet-4.5")).toMatchObject({ priceIn: 3, priceOut: 15, priceEstimated: true, contextLength: 200000 });
    expect(by("gemini-2.5-flash")).toMatchObject({ priceIn: 0.3, priceOut: 2.5, priceEstimated: true });
    expect(by("house-model-1")).toMatchObject({ priceIn: null, priceOut: null, priceEstimated: false });

    // A reseller paid by a flat fee: the user says so, and its models cost nothing per answer.
    expect((await (await env.call("PATCH", `/api/providers/${id}`, { flat: true })).json()).flat).toBe(true);
    const flat = (await (await env.call("GET", `/api/providers/${id}/models`)).json()) as { priceIn: number | null; priceOut: number | null }[];
    expect(flat.every((m) => m.priceIn === 0 && m.priceOut === 0)).toBe(true);
  });
});
