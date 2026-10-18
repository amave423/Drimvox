import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

const KEY = "native-key";
let env: TestEnv;
let vendor: FakeProvider | undefined;
let catalog: FakeProvider;

/** OpenRouter's public catalog: where Artel takes the prices that vendors' own APIs do not give. */
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
    expect(models.map((m: any) => [m.id, m.priceIn])).toEqual([["gemini-2.5-flash", 0.3]]);
    expect(await chatOnce(id, "gemini-2.5-flash")).toMatchObject({ status: "done", content: "Привет из Gemini", inputTokens: 8, outputTokens: 4 });
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
