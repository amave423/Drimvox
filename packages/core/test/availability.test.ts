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
