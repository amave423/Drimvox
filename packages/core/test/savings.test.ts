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

// Asked for: where the money goes, and which model of the same maker would have cost less for the same work.
describe("spending by model", () => {
  it("sums each model's answers and offers cheaper models of the same maker, with what they would have cost", async () => {
    fake = await startFakeProvider({
      key: KEY,
      models: [
        { id: "vendor/big", name: "Big", pricing: { prompt: "0.00001", completion: "0.00003" }, supported_parameters: ["tools"], context_length: 200000 },
        { id: "vendor/small", name: "Small", pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"], context_length: 128000 },
        { id: "vendor/tiny-no-tools", name: "Tiny", pricing: { prompt: "0.0000001", completion: "0.0000002" }, supported_parameters: [], context_length: 8000 },
        { id: "other/cheap", name: "Other", pricing: { prompt: "0.0000001", completion: "0.0000002" }, supported_parameters: ["tools"], context_length: 128000 },
      ],
      chunks: [{ text: "Ответ" }],
    });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const chat = await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "vendor/big" })).json();
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Привет" }));
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Ещё" }));

    const rows = await (await env.call("GET", "/api/usage/models?since=0")).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerName: "Fake", model: "vendor/big", answers: 2 });
    expect(rows[0].costUsd).toBeGreaterThan(0);
    expect(rows[0].cheaper.map((c: { model: string }) => c.model)).toEqual(["vendor/small"]);
    expect(rows[0].cheaper[0].wouldCostUsd).toBeLessThan(rows[0].costUsd);
  });

  it("offers nothing for a model that is not among the provider's chat models (a picture model)", async () => {
    fake = await startFakeProvider({ key: KEY, models: [{ id: "vendor/chat", pricing: { prompt: "0.000001", completion: "0.000002" } }], chunks: [{ text: "Ответ" }] });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    env.db.sql
      .prepare("insert into chats (id, title, provider_id, model, kind, created_at, updated_at) values ('c', 't', ?, 'vendor/painter', 'image', 1, 1)")
      .run(provider.id);
    env.db.sql
      .prepare("insert into messages (id, chat_id, role, content, provider_id, model, input_tokens, output_tokens, cost_usd, status, created_at) values ('m', 'c', 'assistant', '', ?, 'vendor/painter', 10, 10, 0.3, 'done', ?)")
      .run(provider.id, Date.now());
    const rows = await (await env.call("GET", "/api/usage/models?since=0")).json();
    expect(rows[0]).toMatchObject({ model: "vendor/painter", cheaper: [] });
  });
});
