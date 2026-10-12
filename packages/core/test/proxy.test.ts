import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";
import { startFakeProxy, type FakeProxy } from "./fake-proxy";

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider;
let proxy: FakeProxy;

beforeEach(async () => {
  env = createTestEnv();
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "m1", name: "Model 1", pricing: { prompt: "0.000001", completion: "0.000002" } }],
    chunks: [{ text: "Привет через прокси" }],
    routes: { "/ping": { ok: true } },
  });
  proxy = await startFakeProxy({ user: "artem", password: "s3cret" });
});

afterEach(async () => {
  await env.closeAsync();
  await fake.close();
  await proxy.close();
});

async function connect() {
  return (await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json()).id as string;
}

describe("the proxy setting", () => {
  it("keeps the password inside the core", async () => {
    const saved = await env.call("PUT", "/api/proxy", { url: "http://artem:s3cret@127.0.0.1:8080" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ url: "http://artem:•••@127.0.0.1:8080" });
    expect(await (await env.call("GET", "/api/proxy")).json()).toEqual({ url: "http://artem:•••@127.0.0.1:8080" });
    const stored = env.db.sql.prepare("select value from settings").all() as { value: string }[];
    expect(JSON.stringify(stored)).not.toContain("s3cret");

    expect((await env.call("PUT", "/api/proxy", { url: "ftp://127.0.0.1:21" })).status).toBe(400);
    expect(await (await env.call("DELETE", "/api/proxy")).json()).toEqual({ url: null });
  });

  it("checks that the proxy lets requests through", async () => {
    env.setProxyCheckUrl(`${fake.origin}/ping`);
    await env.call("PUT", "/api/proxy", { url: proxy.url });
    const good = await (await env.call("POST", "/api/proxy/check")).json();
    expect(good).toMatchObject({ ok: true });
    expect(proxy.hits.length).toBeGreaterThan(0);

    await env.call("PUT", "/api/proxy", { url: proxy.url.replace("s3cret", "wrong") });
    expect(await (await env.call("POST", "/api/proxy/check")).json()).toMatchObject({ ok: false });
  });
});

describe("providers through the proxy", () => {
  it("sends only the providers that ask for it through the proxy", async () => {
    await env.call("PUT", "/api/proxy", { url: proxy.url });
    const id = await connect();
    expect((await env.call("GET", `/api/providers/${id}/models`)).status).toBe(200);
    expect(proxy.hits).toHaveLength(0);

    const switched = await env.call("PATCH", `/api/providers/${id}`, { useProxy: true });
    expect(await switched.json()).toMatchObject({ useProxy: true });
    expect((await env.call("GET", `/api/providers/${id}/models`)).status).toBe(200);
    const afterModels = proxy.hits.length;
    expect(afterModels).toBeGreaterThan(0);

    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "m1" })).json();
    const events = await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Привет", web: "off" }));
    expect(events.find((e) => e.type === "done").message).toMatchObject({ status: "done", content: "Привет через прокси" });
    expect(proxy.hits.length).toBeGreaterThan(afterModels);
    expect(proxy.hits.every((h) => h.auth === `Basic ${Buffer.from("artem:s3cret").toString("base64")}`)).toBe(true);
  });

  it("says when a provider wants a proxy that is not set", async () => {
    const id = await connect();
    await env.call("PATCH", `/api/providers/${id}`, { useProxy: true });
    const res = await env.call("GET", `/api/providers/${id}/models`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatchObject({ code: "no_proxy" });
  });
});
