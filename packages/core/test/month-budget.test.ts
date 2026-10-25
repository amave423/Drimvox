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

// Asked for: a budget for the whole app per month, with a warning and a stop.
describe("the month's budget", () => {
  it("says how much of it is spent, and refuses new answers once it is used up", async () => {
    // $1 / $2 per 1M tokens: a few cents of a cent an answer.
    fake = await startFakeProvider({ key: KEY, models: [{ id: "m", pricing: { prompt: "0.000001", completion: "0.000002" } }], chunks: [{ text: "Ответ" }] });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const chat = await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "m" })).json();

    expect(await (await env.call("GET", "/api/usage/month")).json()).toMatchObject({ spentUsd: 0, budgetUsd: null });
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Привет" }));
    await env.call("PATCH", "/api/settings", { monthlyBudgetUsd: 0.00001 });
    const month = await (await env.call("GET", "/api/usage/month")).json();
    expect(month.spentUsd).toBeGreaterThan(0.00001);
    expect(month).toMatchObject({ budgetUsd: 0.00001, over: true });

    const refused = await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Ещё" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "month_budget" } });

    // Raised: answers go again.
    await env.call("PATCH", "/api/settings", { monthlyBudgetUsd: 10 });
    expect((await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Ещё" })).status).toBe(200);
  });
});
