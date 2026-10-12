import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

const KEY = "good-key";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
/** Rubles per dollar in these tests. */
const RATE = 80;

let env: TestEnv;
let fake: FakeProvider;

/** RouterAI lists every kind of model in one catalog, priced in rubles per token, image or second. */
const catalog = [
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    context_length: 163840,
    architecture: { output_modalities: ["text"] },
    pricing: { prompt: 0.00008, completion: 0.00016 },
    pricing_units: { prompt: "token", completion: "token" },
    supported_parameters: ["tools"],
  },
  { id: "openai/text-embedding-3-small", name: "Embeddings", architecture: { output_modalities: ["embeddings"] }, pricing: { prompt: 0.000002 } },
  { id: "openai/whisper", name: "Whisper", architecture: { output_modalities: ["transcription"] }, pricing: {} },
  {
    id: "recraft/recraft-v4",
    name: "Recraft V4",
    architecture: { output_modalities: ["image"] },
    pricing: { image_output: 8 },
    pricing_units: { image_output: "image" },
    supported_aspect_ratios: ["1:1", "16:9"],
    image_pricing: [{ unit: "image", variant: null, price: 8 }],
  },
  {
    id: "google/gemini-2.5-flash-image",
    name: "Nano Banana",
    architecture: { output_modalities: ["image", "text"] },
    pricing: { prompt: 0.00003, completion: 0.0003, image_output: 0.003 },
    pricing_units: { prompt: "token", completion: "token", image_output: "token" },
    supported_aspect_ratios: ["1:1", "16:9"],
  },
  {
    id: "x-ai/grok-imagine-video",
    name: "Grok Video",
    architecture: { output_modalities: ["video"] },
    pricing: { seconds: 4 },
    pricing_units: { seconds: "second" },
    supported_durations: [4, 8],
    supported_resolutions: ["480p", "720p"],
    supported_aspect_ratios: ["16:9"],
    generate_audio: null,
  },
];

beforeEach(async () => {
  env = createTestEnv();
  env.setUsdRub(RATE);
  fake = await startFakeProvider({
    key: KEY,
    models: catalog,
    handle: (method, path, body) => {
      // What RouterAI really answers (checked 2026-10-12): what is left, in rubles.
      if (method === "GET" && path === "/v1/credits") return { json: { data: { credits: 287.5 } } };
      if (method === "POST" && path === "/v1/images") {
        return { json: { data: [{ b64_json: PNG.toString("base64") }], usage: { cost: 8 } } };
      }
      if (method === "POST" && path === "/v1/chat/completions" && body?.modalities) {
        return {
          json: {
            choices: [{ message: { role: "assistant", content: "Вот", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } }] } }],
            usage: { prompt_tokens: 10, completion_tokens: 1300, cost: 4 },
          },
        };
      }
      return undefined;
    },
  });
  env.setPresetUrl("routerai", fake.baseUrl);
});

afterEach(async () => {
  await env.closeAsync();
  await fake.close();
});

async function connect() {
  const res = await env.call("POST", "/api/providers", { preset: "routerai", apiKey: KEY });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

describe("RouterAI", () => {
  it("lists only text models for chats, with ruble prices turned into dollars", async () => {
    const id = await connect();
    const models = await (await env.call("GET", `/api/providers/${id}/models`)).json();
    // Nano Banana answers with text as well as pictures, so it is a chat model too.
    expect(models.map((m: any) => m.id)).toEqual(["deepseek/deepseek-v3.2", "google/gemini-2.5-flash-image"]);
    expect(models[0]).toEqual({ id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", contextLength: 163840, priceIn: 1, priceOut: 2, priceEstimated: false, tools: true });
  });

  it("shows the balance in rubles", async () => {
    const id = await connect();
    expect(await (await env.call("GET", `/api/providers/${id}/balance`)).json()).toEqual({ balance: { amount: 287.5, currency: "RUB" } });
  });

  it("finds pictures and video in the same catalog, priced in dollars", async () => {
    const id = await connect();
    const images = await (await env.call("GET", `/api/providers/${id}/media-models?kind=image`)).json();
    expect(images.map((m: any) => m.id)).toEqual(["google/gemini-2.5-flash-image", "recraft/recraft-v4"]);
    const recraft = await (await env.call("GET", `/api/providers/${id}/media-models/one?kind=image&model=recraft/recraft-v4`)).json();
    expect(recraft.pricing.lines).toEqual([{ billable: "output_image", unit: "image", costUsd: 0.1, variant: null }]);

    const videos = await (await env.call("GET", `/api/providers/${id}/media-models?kind=video`)).json();
    expect(videos[0]).toMatchObject({ id: "x-ai/grok-imagine-video", durations: [4, 8], resolutions: ["480p", "720p"], pricing: { skus: { duration_seconds: "0.05" } } });
  });

  it("charges a picture in dollars from the ruble cost", async () => {
    const id = await connect();
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "recraft/recraft-v4", kind: "image" })).json();
    const done = (await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Кот" }))).find((e) => e.type === "done").message;
    expect(done).toMatchObject({ status: "done", costUsd: 0.1 });
  });

  it("draws with chat-style image models through chat completions", async () => {
    const id = await connect();
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "google/gemini-2.5-flash-image", kind: "image" })).json();
    const res = await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Кот", options: { aspectRatio: "16:9" }, confirm: true });
    const done = (await readEvents(res)).find((e) => e.type === "done").message;
    expect(done).toMatchObject({ status: "done", costUsd: 0.05 });
    expect(done.media[0]).toMatchObject({ kind: "image", mime: "image/png" });
    const sent = fake.requests.find((r) => r.path === "/v1/chat/completions")!.body;
    expect(sent).toMatchObject({ model: "google/gemini-2.5-flash-image", modalities: ["image", "text"], image_config: { aspect_ratio: "16:9" } });
  });

  it("turns a custom provider pointing at RouterAI into the RouterAI preset", async () => {
    const res = await env.call("POST", "/api/providers", { preset: "custom", baseUrl: "https://routerai.ru/api/v1", apiKey: KEY });
    expect((await res.json()).preset).toBe("routerai");
  });
});

describe("rates", () => {
  it("gives the interface the dollar rate", async () => {
    expect(await (await env.call("GET", "/api/rates")).json()).toEqual({ usdRub: RATE });
  });
});
