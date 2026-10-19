import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider;

beforeEach(() => {
  env = createTestEnv();
});

afterEach(async () => {
  env.close();
  await fake?.close();
});

const free = { prompt: "0", completion: "0" };
const models = [
  { id: "works:free", pricing: free },
  { id: "gone:free", pricing: free },
  { id: "busy:free", pricing: free },
  { id: "paid", pricing: { prompt: "0.000001", completion: "0.000002" } },
];

async function setup() {
  fake = await startFakeProvider({
    key: KEY,
    models,
    respond: (body) =>
      body.model === "gone:free"
        ? { fail: { status: 404, message: "No endpoints found for gone:free" } }
        : body.model === "busy:free"
          ? { fail: { status: 429, message: "Provider returned error" } }
          : { text: "hi" },
  });
  return (await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json()) as { id: string };
}

const asked = () => fake.requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body.model as string);
const listed = async (id: string) =>
  Object.fromEntries(((await (await env.call("GET", `/api/providers/${id}/models`)).json()) as any[]).map((m) => [m.id, m.available]));

// Seen live: of NVIDIA's 59 listed models 43 answered 404, and OpenRouter's free ones often answer 429 or 403.
describe("free models that answer", () => {
  it("asks each free model a word and tells which answer, which are busy and which are gone", async () => {
    const provider = await setup();
    const res = await env.call("POST", `/api/providers/${provider.id}/models/check`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ "works:free": "ok", "gone:free": "gone", "busy:free": "busy" });
    // Paid models are never asked: that would cost money.
    expect(asked()).not.toContain("paid");
    expect(await listed(provider.id)).toMatchObject({ "works:free": "ok", "gone:free": "gone", "busy:free": "busy" });
    expect((await listed(provider.id)).paid).toBeUndefined();
  });

  it("does not ask again while it remembers", async () => {
    const provider = await setup();
    await env.call("POST", `/api/providers/${provider.id}/models/check`);
    const before = asked().length;
    await env.call("POST", `/api/providers/${provider.id}/models/check`);
    expect(asked().length).toBe(before);
  });

  it("learns from a chat that a model is gone", async () => {
    const provider = await setup();
    const chat = await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "gone:free" })).json();
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Привет" }));
    expect((await listed(provider.id))["gone:free"]).toBe("gone");
  });
});

// Seen live with a free Gemini API key: Google lists 2.5 models that answer "no longer available to new users", and a
// Pro model answers "exceeded your current quota … limit: 0" because it has no free tier. Asking a free-tier model a word
// costs a key without billing nothing.
describe("Google's models", () => {
  let google: FakeProvider;
  afterEach(async () => {
    await google?.close();
  });

  async function connectGoogle() {
    google = await startFakeProvider({
      authorized: (h) => h["x-goog-api-key"] === KEY,
      handle: (method, path) => {
        if (method === "GET" && path === "/v1beta/models") {
          return {
            json: {
              models: ["gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-3.1-pro-preview"].map((m) => ({ name: `models/${m}`, supportedGenerationMethods: ["generateContent"] })),
            },
          };
        }
        if (method === "POST" && path === "/v1beta/models/gemini-3.5-flash-lite:generateContent") {
          return { json: { candidates: [{ content: { parts: [{ text: "Ok" }], role: "model" }, finishReason: "STOP" }] } };
        }
        if (method === "POST" && path === "/v1beta/models/gemini-2.5-flash:generateContent") {
          return { status: 404, json: { error: { code: 404, message: "This model models/gemini-2.5-flash is no longer available to new users." } } };
        }
        if (method === "POST" && path.startsWith("/v1beta/models/gemini-3.1-pro-preview:")) {
          return {
            status: 429,
            json: { error: { code: 429, message: "You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro" } },
          };
        }
        return undefined;
      },
    });
    env.setPresetUrl("google", `${google.origin}/v1beta`);
    return (await (await env.call("POST", "/api/providers", { preset: "google", apiKey: KEY })).json()) as { id: string };
  }

  it("asks the free-tier ones a word and hides those Google no longer serves", async () => {
    const { id } = await connectGoogle();
    const states = await (await env.call("POST", `/api/providers/${id}/models/check`)).json();
    expect(states).toEqual({ "gemini-3.5-flash-lite": "ok", "gemini-2.5-flash": "gone" });
    // A model without a free tier is not asked: on a key with billing it would cost money.
    expect(google.requests.some((r) => r.path.includes("gemini-3.1-pro-preview"))).toBe(false);
  });

  it("says plainly that a model has no free tier for this key", async () => {
    const { id } = await connectGoogle();
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "gemini-3.1-pro-preview" })).json();
    const events = await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Привет" }));
    expect(events.at(-1).message.error).toMatchObject({ code: "no_free_tier" });
  });
});
