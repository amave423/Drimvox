import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

// Seen live: the free DuckDuckGo search was blocked again and again; a search service's key makes it reliable.
let env: TestEnv;
let server: Server;
let base: string;
const seen: { path: string; auth: string | undefined; body: string }[] = [];

beforeEach(async () => {
  seen.length = 0;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const auth = (req.headers.authorization ?? req.headers["x-subscription-token"]) as string | undefined;
      seen.push({ path: req.url ?? "", auth, body });
      res.setHeader("Content-Type", "application/json");
      if (auth !== "Bearer tvly-good" && auth !== "brave-good") {
        res.statusCode = 401;
        return res.end(JSON.stringify({ detail: { error: "Unauthorized" } }));
      }
      if (req.url?.startsWith("/search"))
        return res.end(JSON.stringify({ results: [{ title: "Лесопилка", url: "https://wood.example/", content: "Доски и брус" }] }));
      res.end(JSON.stringify({ web: { results: [{ title: "Брус", url: "https://brus.example/", description: "Брус <strong>дёшево</strong>" }] } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env = createTestEnv();
  env.setSearchUrls({ tavily: `${base}/search`, brave: `${base}/res/v1/web/search` });
});

let fake: FakeProvider | undefined;

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  await new Promise((r) => server.close(r));
});

describe("a search service with a key", () => {
  it("keeps the key inside the core and checks it", async () => {
    expect(await (await env.call("GET", "/api/search")).json()).toEqual({ service: "free", hasKey: false });
    const saved = await env.call("PUT", "/api/search", { service: "tavily", key: "tvly-good" });
    expect(await saved.json()).toEqual({ service: "tavily", hasKey: true });
    const stored = env.db.sql.prepare("select value from settings").all() as { value: string }[];
    expect(JSON.stringify(stored)).not.toContain("tvly-good");
    expect(await (await env.call("POST", "/api/search/check")).json()).toMatchObject({ ok: true });

    await env.call("PUT", "/api/search", { service: "tavily", key: "tvly-bad" });
    expect(await (await env.call("POST", "/api/search/check")).json()).toMatchObject({ ok: false, error: { code: "auth" } });
    await env.call("DELETE", "/api/search");
    expect(await (await env.call("GET", "/api/search")).json()).toEqual({ service: "free", hasKey: false });
  });

  it("searches with Tavily or Brave when a key is set, and their results read like the free search's", async () => {
    await env.call("PUT", "/api/search", { service: "tavily", key: "tvly-good" });
    const tavily = await (await env.call("POST", "/api/search/check", { query: "лесопилка" })).json();
    expect(tavily.results).toEqual([{ title: "Лесопилка", url: "https://wood.example/", snippet: "Доски и брус" }]);
    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({ query: "лесопилка" });

    await env.call("PUT", "/api/search", { service: "brave", key: "brave-good" });
    const brave = await (await env.call("POST", "/api/search/check", { query: "брус" })).json();
    expect(brave.results).toEqual([{ title: "Брус", url: "https://brus.example/", snippet: "Брус дёшево" }]);
    expect(seen.at(-1)!.path).toContain("q=%D0%B1%D1%80%D1%83%D1%81");
  });

  it("is what a chat with the internet searches with", async () => {
    await env.call("PUT", "/api/search", { service: "tavily", key: "tvly-good" });
    fake = await startFakeProvider({
      key: "k",
      models: [{ id: "m1", name: "Model 1" }],
      script: [{ toolCalls: [{ name: "web_search", args: { query: "лесопилка" } }] }, { text: "Нашёл лесопилку." }],
    });
    const provider = (await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: "k" })).json()).id;
    const chat = await (await env.call("POST", "/api/chats", { providerId: provider, model: "m1" })).json();
    const events = await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Найди лесопилку", web: "free" }));
    expect(events.find((e: any) => e.type === "done").message).toMatchObject({ status: "done" });
    expect(JSON.stringify(fake.requests.filter((r) => r.path === "/v1/chat/completions")[1]!.body.messages)).toContain("Доски и брус");
  });
});
