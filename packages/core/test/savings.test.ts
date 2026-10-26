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

// Asked for: where the money goes, only the spending, and all of it.
describe("spending by model", () => {
  it("sums each model's chat answers and what agents' tasks spent, without guessing at other models", async () => {
    fake = await startFakeProvider({ key: KEY, models: [{ id: "vendor/big", name: "Big", pricing: { prompt: "0.00001", completion: "0.00003" } }], chunks: [{ text: "Ответ" }] });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const chat = await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "vendor/big" })).json();
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Привет" }));
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Ещё" }));
    const chats = (await (await env.call("GET", "/api/usage/models?since=0")).json())[0].costUsd;

    // A project's interview spent on the same model, kept apart from the chats (seen: it was missing from the list).
    env.db.sql.prepare("insert into projects values ('p', 'p', 'C:/p', 1)").run();
    env.db.sql
      .prepare(
        "insert into tasks (id, project_id, title, task, provider_id, model, status, branch, worktree, base_commit, budget_usd, created_at, updated_at) values ('t', 'p', 't', 't', ?, 'vendor/big', 'done', 'b', 'w', 'c', 1, 1, 1)",
      )
      .run(provider.id);
    env.db.sql.prepare("insert into agent_usage values ('t', 1000, 100, 0.5, 1, ?)").run(Date.now());
    // A task gone with its project still counts.
    env.db.sql.prepare("insert into agent_usage values ('gone', 10, 10, 0.25, 1, ?)").run(Date.now());

    const rows = await (await env.call("GET", "/api/usage/models?since=0")).json();
    expect(rows[0]).toEqual({ providerId: provider.id, providerName: "Fake", model: "vendor/big", answers: 3, inputTokens: expect.any(Number), outputTokens: expect.any(Number), costUsd: expect.closeTo(chats + 0.5, 6) });
    expect(rows[1]).toMatchObject({ providerName: "—", model: "—", costUsd: 0.25 });
    expect(rows[0]).not.toHaveProperty("cheaper");
  });
});
