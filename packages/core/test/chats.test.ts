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

  it("prices input served from the provider's cache at the cache price", async () => {
    const { chat } = await setup({
      models: [{ id: "fake-model", name: "Fake Model", pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" } }],
      chunks: [{ text: "Привет" }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 800 } },
    });
    const done = (await readEvents(await send(chat.id, "Привет"))).at(-1).message;
    // 200 fresh tokens at $1/M, 800 cached at $0.1/M, 500 out at $2/M.
    expect(done.costUsd).toBeCloseTo(0.00128, 10);
  });

  it("keeps the conversation and sends the history upstream", async () => {
    const { chat } = await setup({ chunks: [{ text: "Ответ" }] });
    await readEvents(await send(chat.id, "Первый"));
    await readEvents(await send(chat.id, "Второй"));

    // After the system line with the date.
    const sent = fake.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)?.body.messages.slice(1);
    expect(sent).toEqual([
      { role: "user", content: "Первый" },
      { role: "assistant", content: "Ответ" },
      { role: "user", content: "Второй" },
    ]);
    const saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
    expect(saved.messages.map((m: { content: string }) => m.content)).toEqual(["Первый", "Ответ", "Второй", "Ответ"]);
  });

  it("tells the model today's date and time", async () => {
    const { chat } = await setup();
    await readEvents(await send(chat.id, "Какое сегодня число?"));
    const messages = fake.requests.find((r) => r.path === "/v1/chat/completions")!.body.messages;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(String(new Date().getFullYear()));
    expect(messages[0].content).toMatch(/\d{2}:\d{2}/);
    // The chat draws formulas and Mermaid diagrams; the model is told so.
    expect(messages[0].content).toContain("mermaid");
  });

  describe("with the internet", () => {
    const searched: string[] = [];
    const fakeWeb = {
      search: async (q: string) => {
        searched.push(q);
        return [{ title: "Погода в Москве", url: "https://weather.example/moscow", snippet: "Сейчас +5 °C, облачно" }];
      },
      open: async (url: string) => ({ url, title: "Москва", text: "Подробный прогноз" }),
    };

    it("searches with Drimvox's own tools and answers from the results", async () => {
      env.setWeb(fakeWeb);
      const { chat } = await setup({
        script: [{ toolCalls: [{ name: "web_search", args: { query: "погода Москва" } }] }, { text: "Сейчас в Москве +5 °C." }],
      });
      const events = await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Какая погода?", web: "free" }));
      expect(events.filter((e) => e.type === "tool")).toEqual([{ type: "tool", name: "web_search", input: "погода Москва" }]);
      expect(events.find((e) => e.type === "done").message).toMatchObject({ status: "done", content: "Сейчас в Москве +5 °C." });
      expect(searched).toEqual(["погода Москва"]);
      const requests = fake.requests.filter((r) => r.path === "/v1/chat/completions");
      expect(requests[0]!.body.tools.map((t: any) => t.function.name)).toEqual(["web_search", "open_page"]);
      expect(JSON.stringify(requests[1]!.body.messages)).toContain("Сейчас +5 °C, облачно");
    });

    // Seen: sites like the trademark databases draw their results with scripts; open_page saw only "Loading…". A real
    // browser reads what the page shows, after the steps the model asks for.
    it("reads a page in a real browser, after steps such as typing a name and pressing search", async () => {
      const rendered: { url: string; steps: unknown }[] = [];
      env.setWeb({
        ...fakeWeb,
        render: async (url: string, steps?: unknown) => {
          rendered.push({ url, steps: steps ?? null });
          return { url, title: "Global Brand Database", text: "Brand name: contains the word 'seppora'\nNo results found!" };
        },
      });
      const steps = [
        { action: "type", target: "Brand name", text: "seppora" },
        { action: "press", text: "Enter" },
        { action: "wait", ms: 3000 },
      ];
      const { chat } = await setup({
        script: [{ toolCalls: [{ name: "browse_page", args: { url: "https://branddb.wipo.int/en/similarname", steps } }] }, { text: "Знаков Seppora нет." }],
      });
      const events = await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Проверь знак Seppora", web: "free" }));
      expect(events.filter((e) => e.type === "tool")).toEqual([{ type: "tool", name: "browse_page", input: "https://branddb.wipo.int/en/similarname" }]);
      expect(rendered).toEqual([{ url: "https://branddb.wipo.int/en/similarname", steps }]);
      const requests = fake.requests.filter((r) => r.path === "/v1/chat/completions");
      expect(requests[0]!.body.tools.map((t: any) => t.function.name)).toEqual(["web_search", "open_page", "browse_page"]);
      expect(JSON.stringify(requests[1]!.body.messages)).toContain("No results found!");
    });

    // Seen live: checking a few names took more than 8 steps, and five answers of eight stopped half-way with "go on".
    it("gives an answer with the internet room for research, far past 8 steps", async () => {
      env.setWeb(fakeWeb);
      const search = (n: number) => ({ toolCalls: [{ name: "web_search", args: { query: `name ${n}` } }] });
      const { chat } = await setup({ script: [...Array.from({ length: 12 }, (_, n) => search(n % 6)), { text: "Проверил все двенадцать." }] });
      const events = await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Проверь 12 названий", web: "free" }));
      expect(events.find((e) => e.type === "done").message).toMatchObject({ status: "done", content: "Проверил все двенадцать.", error: null });
      // The same query again is answered from what was found, not asked of DuckDuckGo twice (it limits bursts).
      expect(searched.filter((q) => q === "name 1")).toHaveLength(1);
    });

    // Seen live: a model typed into a field that was not there twelve times in one answer.
    it("stops a failing browser step repeated as it is, and says what the page has instead", async () => {
      let tries = 0;
      env.setWeb({
        ...fakeWeb,
        render: async () => {
          tries++;
          throw new Error('Step 1 (type Search trademarks): not found on the page: Search trademarks. Fields here: "brand name". Buttons and links: "search"');
        },
      });
      const same = { toolCalls: [{ name: "browse_page", args: { url: "https://branddb.wipo.int/en/quicksearch", steps: [{ action: "type", target: "Search trademarks", text: "velmir" }] } }] };
      const { chat } = await setup({ script: [same, same, same, same, { text: "Не вышло." }] });
      await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Проверь Velmir", web: "free" }));
      expect(tries).toBe(2);
      const last = JSON.stringify(fake.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!.body.messages);
      expect(last).toContain("brand name");
      expect(last).toMatch(/already failed twice/);
    });

    // Seen live: "I need names in English" turned the whole conversation into English.
    it("tells the model to answer in the user's language even when the user asks for words in another", async () => {
      const { chat } = await setup();
      await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Придумай названия на английском", web: "free" }));
      const system = JSON.stringify(fake.requests.find((r) => r.path === "/v1/chat/completions")!.body.messages[0]);
      expect(system).toMatch(/language the user writes in/);
      // Seen live: a model met a site's bot check and started computing its answer to get through.
      expect(system).toMatch(/never try to get around captchas/i);
    });

    // Seen live: the model had nearly finished thinking and searching, and the answer was cut as "silent" — the time
    // Drimvox's own search took counted as the model's silence.
    it("does not count the time a search takes as the model's silence", async () => {
      env.setWeb({ ...fakeWeb, search: async (q: string) => (await new Promise((r) => setTimeout(r, 500)), fakeWeb.search(q)) });
      env.setIdleTimeout(200);
      const { chat } = await setup({
        script: [{ toolCalls: [{ name: "web_search", args: { query: "погода Москва" } }] }, { text: "Сейчас в Москве +5 °C." }],
      });
      const events = await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Какая погода?", web: "free" }));
      expect(events.find((e) => e.type === "done").message).toMatchObject({ status: "done", content: "Сейчас в Москве +5 °C." });
    });

    it("asks the provider to search when the user picks the provider's search", async () => {
      const { chat } = await setup();
      await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Новости?", web: "provider" }));
      const body = fake.requests.find((r) => r.path === "/v1/chat/completions")!.body;
      expect(body.plugins).toEqual([{ id: "web", max_results: 5 }]);
      expect(body.tools).toBeUndefined();
    });

    it("sends no tools when the internet is off", async () => {
      const { chat } = await setup();
      await readEvents(await send(chat.id, "Привет"));
      const body = fake.requests.find((r) => r.path === "/v1/chat/completions")!.body;
      expect(body.tools).toBeUndefined();
      expect(body.plugins).toBeUndefined();
    });
  });

  it("names the chat after the first message", async () => {
    const { chat } = await setup();
    await readEvents(await send(chat.id, "Как настроить Vite с прокси для API?\nПодробнее ниже"));
    const saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
    expect(saved.title).toBe("Как настроить Vite с прокси для API?");
  });

  // Seen live: the whole first message became the chat's name in the list.
  it("gives the chat a short name the model makes up from the first message", async () => {
    const { chat } = await setup({ title: "«Покраска забора.»", script: [{ text: "Сначала зачистите ржавчину." }] });
    const long = "у меня есть 1к грунт цинконаполненный, алкидная эмаль и старый ржавый забор, как его лучше покрасить, чтобы держалось лет десять";
    await readEvents(await send(chat.id, long));
    let saved: any;
    for (let i = 0; i < 50; i++) {
      saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
      if (saved.title === "Покраска забора") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(saved.title).toBe("Покраска забора");
  });

  it("names the chat after a short first sentence, cut at a word, until the model's name comes", async () => {
    const { chat } = await setup();
    await readEvents(await send(chat.id, "у меня есть 1к грунт цинконаполненный, алкидная эмаль и старый ржавый забор. Как покрасить?"));
    const saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
    expect(saved.title).toBe("у меня есть 1к грунт цинконаполненный,…");
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
    // After the system line with the date.
    const sent = fake.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)?.body.messages.slice(1);
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

  // Seen live: a local model with a small context stopped mid-answer, and the answer looked finished.
  // Seen live: a long page of code stopped mid-tag at the answer's length; the model would have gone on.
  it("goes on by itself, in the same answer, when the model stops at the answer's length", async () => {
    const { chat } = await setup({ script: [{ text: "<div>начало", finishReason: "length" }, { text: " и конец</div>" }] });
    const events = await readEvents(await send(chat.id, "Напиши страницу"));
    expect(events.at(-1).message).toMatchObject({ status: "done", content: "<div>начало и конец</div>", error: null });
    const second = fake.requests.filter((r) => r.path === "/v1/chat/completions")[1]!.body.messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant" });
    expect(second.at(-1).content).toMatch(/Continue exactly where it stopped/);
  });

  it("says when the model ran out of room even after going on twice, and keeps the answer so it can go on", async () => {
    const { chat } = await setup({ chunks: [{ text: "Начало кода" }], finishReason: "length" });
    const events = await readEvents(await send(chat.id, "Напиши сайт"));
    expect(events.at(-1).message).toMatchObject({ status: "done", content: "Начало кодаНачало кодаНачало кода", error: { code: "cut_off" } });
    expect(fake.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(3);
    await readEvents(await send(chat.id, "Продолжи"));
    const sent = fake.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)?.body.messages.slice(1);
    expect(sent).toContainEqual({ role: "assistant", content: "Начало кода" });
  });

  it("gives up on a model that stays silent", async () => {
    const { chat } = await setup({ chunks: [{ text: "Начал" }, { text: " и замолчал" }], delayMs: 400 });
    env.setIdleTimeout(150);
    const events = await readEvents(await send(chat.id, "Привет"));
    expect(events.at(-1).message).toMatchObject({ status: "error", content: "Начал", error: { code: "timeout" } });
  });

  // Seen: leaving a chat while the model answered, then coming back, showed an empty answer that said a clip was
  // being made, and nothing could stop it. The answer is saved as it goes and stops from anywhere.
  it("keeps what an answer has so far, and stops it from another window", async () => {
    const { chat } = await setup({ chunks: Array.from({ length: 40 }, (_, i) => ({ text: `кусок ${i} ` })), delayMs: 100 });
    const answer = readEvents(await send(chat.id, "Напиши длинно"));
    const partial = async () => (await (await env.call("GET", `/api/chats/${chat.id}`)).json()).messages.at(-1);
    let seen: any;
    for (let i = 0; i < 60; i++) {
      seen = await partial();
      if (seen?.status === "streaming" && seen.content.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(seen).toMatchObject({ role: "assistant", status: "streaming" });
    expect(seen.content).toMatch(/^кусок 0 /);
    expect((await env.call("POST", `/api/chats/${chat.id}/stop`)).status).toBe(200);
    await answer;
    expect(await partial()).toMatchObject({ status: "stopped" });
    // Nothing to stop any more.
    expect((await env.call("POST", `/api/chats/${chat.id}/stop`)).status).toBe(404);
  });

  // Like ChatGPT and Claude: back in the chat, the answer goes on before the reader's eyes, from what it has so far.
  it("lets a window coming back follow the answer live: what it has so far, then the rest as it comes", async () => {
    const { chat } = await setup({ chunks: Array.from({ length: 20 }, (_, i) => ({ text: `кусок ${i} ` })), delayMs: 60 });
    const answer = readEvents(await send(chat.id, "Напиши длинно"));
    const list = async () => ((await (await env.call("GET", "/api/chats")).json()) as any[]).find((c) => c.id === chat.id);
    for (let i = 0; i < 60 && !(await list())?.answering; i++) await new Promise((r) => setTimeout(r, 30));
    expect(await list()).toMatchObject({ answering: true, unread: false });
    await new Promise((r) => setTimeout(r, 300));
    const followed = await readEvents(await env.call("GET", `/api/chats/${chat.id}/follow`));
    expect(followed[0]).toMatchObject({ type: "snapshot" });
    expect(followed[0].content).toMatch(/^кусок 0 /);
    expect(followed.at(-1)).toMatchObject({ type: "done" });
    const rest = followed.filter((e) => e.type === "text").map((e) => e.text).join("");
    expect(followed[0].content + rest).toBe(Array.from({ length: 20 }, (_, i) => `кусок ${i} `).join(""));
    await answer;
    // Answered while nobody looked: a dot until the chat is opened.
    expect(await list()).toMatchObject({ answering: false, unread: true });
    expect((await env.call("POST", `/api/chats/${chat.id}/seen`)).status).toBe(200);
    expect(await list()).toMatchObject({ unread: false });
    // Nothing to follow any more: the stream ends at once.
    expect(await readEvents(await env.call("GET", `/api/chats/${chat.id}/follow`))).toEqual([]);
  });

  it("marks an answer left mid-way by a closed app as stopped, not writing forever", async () => {
    const { chat } = await setup();
    await readEvents(await send(chat.id, "Привет"));
    env.db.sql.prepare("update messages set status = 'streaming' where role = 'assistant'").run();
    env.reopen();
    const last = (await (await env.call("GET", `/api/chats/${chat.id}`)).json()).messages.at(-1);
    expect(last.status).toBe("stopped");
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
