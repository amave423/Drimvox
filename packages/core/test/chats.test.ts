import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeProviderOptions } from "./fake-provider";

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

/** Priced like OpenRouter so cost can be checked: $1 / $2 per 1M tokens. */
const pricedModels = [{ id: "fake-model", pricing: { prompt: "0.000001", completion: "0.000002" } }];

async function setup(options: FakeProviderOptions = {}, apiKey = KEY) {
  fake = await startFakeProvider({ key: KEY, models: pricedModels, ...options });
  const provider = await (
    await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey })
  ).json();
  const chat = await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "fake-model" })).json();
  return { provider, chat };
}

const send = (chatId: string, content: string) => env.call("POST", `/api/chats/${chatId}/messages`, { content });

describe("chats", () => {
  it("creates, lists and deletes chats", async () => {
    const { chat } = await setup();
    expect(chat).toMatchObject({ title: null, model: "fake-model" });
    expect((await (await env.call("GET", "/api/chats")).json()).length).toBe(1);
    expect((await env.call("DELETE", `/api/chats/${chat.id}`)).status).toBe(204);
    expect(await (await env.call("GET", "/api/chats")).json()).toEqual([]);
  });

  it("refuses a chat with an unknown provider", async () => {
    const res = await env.call("POST", "/api/chats", { providerId: "nope", model: "m" });
    expect(res.status).toBe(400);
  });

  it("switches the model of a chat", async () => {
    const { chat } = await setup();
    const res = await env.call("PATCH", `/api/chats/${chat.id}`, { model: "other" });
    expect(await res.json()).toMatchObject({ model: "other" });
  });
});

describe("sending a message", () => {
  it("streams reasoning and text, then saves the answer with tokens and cost", async () => {
    const { chat } = await setup({ chunks: [{ reasoning: "Думаю" }, { text: "При" }, { text: "вет" }], usage: { prompt_tokens: 1000, completion_tokens: 500 } });
    const events = await readEvents(await send(chat.id, "Привет"));

    expect(events.map((e) => e.type)).toEqual(["start", "reasoning", "text", "text", "done"]);
    expect(events[0].userMessage).toMatchObject({ role: "user", content: "Привет" });
    const done = events.at(-1).message;
    expect(done).toMatchObject({
      role: "assistant",
      content: "Привет",
      reasoning: "Думаю",
      model: "fake-model",
      inputTokens: 1000,
      outputTokens: 500,
      status: "done",
      error: null,
    });
    expect(done.costUsd).toBeCloseTo(0.002, 10);
  });

  it("keeps the conversation and sends the history upstream", async () => {
    const { chat } = await setup({ chunks: [{ text: "Ответ" }] });
    await readEvents(await send(chat.id, "Первый"));
    await readEvents(await send(chat.id, "Второй"));

    const sent = fake.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)?.body.messages;
    expect(sent).toEqual([
      { role: "user", content: "Первый" },
      { role: "assistant", content: "Ответ" },
      { role: "user", content: "Второй" },
    ]);
    const saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
    expect(saved.messages.map((m: { content: string }) => m.content)).toEqual(["Первый", "Ответ", "Второй", "Ответ"]);
  });

  it("names the chat after the first message", async () => {
    const { chat } = await setup();
    await readEvents(await send(chat.id, "Как настроить Vite с прокси для API?\nПодробнее ниже"));
    const saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
    expect(saved.title).toBe("Как настроить Vite с прокси для API?");
  });

  it("saves a provider error on the answer instead of failing the request", async () => {
    const { chat } = await setup({ failWith: { status: 402, message: "Insufficient credits" } });
    const events = await readEvents(await send(chat.id, "Привет"));
    expect(events.at(-1).message).toMatchObject({
      status: "error",
      content: "",
      error: { code: "no_funds", detail: "Insufficient credits" },
    });
  });

  it("does not send an errored answer back as history", async () => {
    const { chat } = await setup({ failWith: { status: 500, message: "boom" } });
    await readEvents(await send(chat.id, "Раз"));
    await readEvents(await send(chat.id, "Два"));
    const sent = fake.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)?.body.messages;
    expect(sent).toEqual([
      { role: "user", content: "Раз" },
      { role: "user", content: "Два" },
    ]);
  });

  it("stops when the client goes away and keeps what was written", async () => {
    const { chat } = await setup({ chunks: [{ text: "Часть" }, { text: " ещё" }, { text: " и ещё" }], delayMs: 300 });
    const res = await send(chat.id, "Длинный ответ");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes('"type":"text"')) seen += decoder.decode((await reader.read()).value);
    await reader.cancel();
    await fake.aborted;

    let answer: any;
    for (let i = 0; i < 50 && answer?.status !== "stopped"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      answer = (await (await env.call("GET", `/api/chats/${chat.id}`)).json()).messages.at(-1);
    }
    expect(answer).toMatchObject({ status: "stopped", content: "Часть" });
  });

  it("answers 404 for an unknown chat", async () => {
    await setup();
    expect((await send("nope", "hi")).status).toBe(404);
  });

  it("refuses an empty message", async () => {
    const { chat } = await setup();
    expect((await send(chat.id, "   ")).status).toBe(400);
  });
});

describe("usage", () => {
  it("sums tokens and cost since a moment", async () => {
    const { chat } = await setup({ usage: { prompt_tokens: 1000, completion_tokens: 1000 } });
    const before = Date.now();
    await readEvents(await send(chat.id, "Раз"));
    await readEvents(await send(chat.id, "Два"));

    const usage = await (await env.call("GET", `/api/usage?since=${before}`)).json();
    expect(usage).toMatchObject({ inputTokens: 2000, outputTokens: 2000, unpricedMessages: 0 });
    expect(usage.costUsd).toBeCloseTo(0.006, 10);

    const later = await (await env.call("GET", `/api/usage?since=${Date.now() + 1000}`)).json();
    expect(later).toMatchObject({ inputTokens: 0, costUsd: 0 });
  });
});

describe("recovery", () => {
  it("marks answers cut off by a crash as stopped", async () => {
    const { chat } = await setup();
    env.db.sql
      .prepare("insert into messages (id, chat_id, role, content, status, created_at) values ('m1', ?, 'assistant', 'полу', 'streaming', 1)")
      .run(chat.id);
    env.reopen();
    const saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
    expect(saved.messages.at(-1)).toMatchObject({ id: "m1", status: "stopped", content: "полу" });
  });
});
