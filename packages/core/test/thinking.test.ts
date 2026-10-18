import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { thinkingOptions } from "../src/chats/thinking";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

describe("how much a model thinks, as each provider is told", () => {
  it("asks OpenRouter-style providers for an effort, or for no reasoning", () => {
    expect(thinkingOptions("routerai", "low")).toEqual({ routerai: { reasoning: { effort: "low" } } });
    expect(thinkingOptions("openrouter", "off")).toEqual({ openrouter: { reasoning: { enabled: false } } });
  });

  it("turns DeepSeek's thinking off or on", () => {
    expect(thinkingOptions("deepseek", "off")).toEqual({ deepseek: { thinking: { type: "disabled" } } });
    expect(thinkingOptions("deepseek", "high")).toEqual({ deepseek: { thinking: { type: "enabled" } } });
  });

  it("gives the vendors their own settings", () => {
    expect(thinkingOptions("anthropic", "medium")).toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } } });
    expect(thinkingOptions("openai", "high")).toEqual({ openai: { reasoningEffort: "high" } });
    expect(thinkingOptions("google", "off")).toEqual({ google: { thinkingConfig: { thinkingBudget: 0 } } });
  });

  it("leaves the provider's own choice on auto", () => {
    expect(thinkingOptions("routerai", "auto")).toBeUndefined();
  });
});

const KEY = "good-key";
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

async function chat(chunks: { reasoning?: string; text?: string }[]) {
  fake = await startFakeProvider({ key: KEY, models: [{ id: "m" }], chunks });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  return (await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "m" })).json()) as { id: string };
}

describe("thinking in a chat", () => {
  it("sends the chosen level with the question", async () => {
    const c = await chat([{ text: "Ответ" }]);
    await readEvents(await env.call("POST", `/api/chats/${c.id}/messages`, { content: "Вопрос", thinking: "low" }));
    const body = fake!.requests.find((r) => r.path === "/v1/chat/completions")!.body;
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  // Seen live: a model thought 90 000 characters and wrote nothing; the chat showed an empty "done" answer.
  it("says so when the model only thought and gave no answer", async () => {
    const c = await chat([{ reasoning: "Думаю, думаю, думаю…" }]);
    const events = await readEvents(await env.call("POST", `/api/chats/${c.id}/messages`, { content: "Что это за игра?" }));
    expect(events.at(-1).message).toMatchObject({ status: "error", error: { code: "no_answer" } });
  });
});
