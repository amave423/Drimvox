import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

const KEY = "oc_sk_test";
let env: TestEnv;
let fake: FakeProvider | undefined;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(async () => {
  env.close();
  await fake?.close();
  fake = undefined;
});

// OpenCode's own model format, as https://opencode.ai/inference/go/openai/v1/models lists it.
const GO_MODEL = {
  id: "deepseek-v4.1-flash",
  object: "model",
  name: "DeepSeek V4.1 Flash 1017",
  type: "chat",
  modalities: { input: ["text", "image/png"], output: ["text"] },
  capabilities: { tools: { supported: true }, reasoning: { supported: true } },
  limit: { context: 1_000_000, output: 384_000 },
};

async function connectGo() {
  fake = await startFakeProvider({ key: KEY, models: [GO_MODEL], script: [{ text: "Привет" }, { text: "Ещё раз" }] });
  env.setPresetUrl("opencode-go", fake.baseUrl);
  const res = await env.call("POST", "/api/providers", { preset: "opencode-go", apiKey: KEY });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

// Asked for: the OpenCode Go subscription ($10 a month: DeepSeek V4.1 Flash, GPT-6 Luna, GLM, Kimi…) in Drimvox.
describe("OpenCode Go", () => {
  it("lists its models with their window, tools and pictures, free by the subscription", async () => {
    const id = await connectGo();
    const models = await (await env.call("GET", `/api/providers/${id}/models`)).json();
    expect(models[0]).toMatchObject({ id: "deepseek-v4.1-flash", contextLength: 1_000_000, tools: true, vision: true, priceIn: 0, priceOut: 0 });
  });

  // Go answers only requests that carry a stable session id per conversation (x-opencode-session), from an app that
  // names itself: "Apps that don't send a session ID can't use Go models".
  it("sends one session id per conversation, the same for its every request, and names Drimvox", async () => {
    const id = await connectGo();
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "deepseek-v4.1-flash" })).json();
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Привет" }));
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Ещё" }));
    const asks = fake!.requests.filter((r) => r.path.endsWith("/chat/completions"));
    expect(asks).toHaveLength(2);
    const sessions = asks.map((r) => r.headers["x-opencode-session"]);
    expect(sessions[0]).toMatch(/^ses_[a-z0-9]+$/);
    expect(sessions[1]).toBe(sessions[0]);
    expect(String(asks[0]!.headers["user-agent"])).toMatch(/^Drimvox\//);
    const other = await (await env.call("POST", "/api/chats", { providerId: id, model: "deepseek-v4.1-flash" })).json();
    await readEvents(await env.call("POST", `/api/chats/${other.id}/messages`, { content: "Другой" }));
    const third = fake!.requests.filter((r) => r.path.endsWith("/chat/completions")).at(-1)!;
    expect(third.headers["x-opencode-session"]).not.toBe(sessions[0]);
  });
});
