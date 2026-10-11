import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

const KEY = "sk-very-secret-key-1234567890";

let env: TestEnv;
let fake: FakeProvider;

beforeEach(async () => {
  env = createTestEnv();
  fake = await startFakeProvider({ key: KEY });
});

afterEach(async () => {
  env.close();
  await fake.close();
});

async function addCustom(apiKey = KEY) {
  const res = await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe("connecting providers", () => {
  it("fills name and address from the preset", async () => {
    const res = await env.call("POST", "/api/providers", { preset: "deepseek", apiKey: KEY });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      preset: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      hasKey: true,
      billing: "paid",
    });
  });

  it("never returns the key", async () => {
    await addCustom();
    const created = await env.call("POST", "/api/providers", { preset: "openrouter", apiKey: KEY });
    const list = await env.call("GET", "/api/providers");
    expect(await created.text()).not.toContain(KEY);
    expect(await list.text()).not.toContain(KEY);
  });

  it("stores the key encrypted", async () => {
    await addCustom();
    const rows = env.db.sql.prepare("select * from providers").all();
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it("requires a key where the provider needs one", async () => {
    const res = await env.call("POST", "/api/providers", { preset: "openrouter" });
    expect(res.status).toBe(400);
  });

  it("allows local servers without a key", async () => {
    const res = await env.call("POST", "/api/providers", { preset: "ollama" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ hasKey: false, billing: "free", baseUrl: "http://127.0.0.1:11434/v1" });
  });

  it("requires an address for a custom provider", async () => {
    const res = await env.call("POST", "/api/providers", { preset: "custom", apiKey: KEY });
    expect(res.status).toBe(400);
  });

  it("does not let a fixed preset point elsewhere", async () => {
    const res = await env.call("POST", "/api/providers", { preset: "openrouter", apiKey: KEY, baseUrl: "http://evil.example/v1" });
    expect(res.status).toBe(400);
  });

  it("replaces the key and renames", async () => {
    const { id } = await addCustom("old-key");
    const res = await env.call("PATCH", `/api/providers/${id}`, { apiKey: KEY, name: "Renamed" });
    expect(await res.json()).toMatchObject({ name: "Renamed", hasKey: true });
    const models = await env.call("GET", `/api/providers/${id}/models`);
    expect(models.status).toBe(200);
  });

  it("deletes a provider", async () => {
    const { id } = await addCustom();
    expect((await env.call("DELETE", `/api/providers/${id}`)).status).toBe(204);
    expect(await (await env.call("GET", "/api/providers")).json()).toEqual([]);
    expect((await env.call("DELETE", `/api/providers/${id}`)).status).toBe(404);
  });

  it("keeps the key readable after the database is reopened", async () => {
    const { id } = await addCustom();
    env.reopen();
    expect((await env.call("GET", `/api/providers/${id}/models`)).status).toBe(200);
  });
});

describe("models", () => {
  it("lists models of the provider", async () => {
    const { id } = await addCustom();
    const res = await env.call("GET", `/api/providers/${id}/models`);
    const models = await res.json();
    expect(models.map((m: { id: string }) => m.id)).toEqual(["fake-large", "fake-small"]);
    expect(fake.requests.at(-1)?.auth).toBe(`Bearer ${KEY}`);
  });

  it("explains a wrong key", async () => {
    const { id } = await addCustom("wrong");
    const res = await env.call("GET", `/api/providers/${id}/models`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "bad_key", detail: "Invalid API key" } });
  });

  it("explains an unreachable provider", async () => {
    const { id } = await addCustom();
    await fake.close();
    const res = await env.call("GET", `/api/providers/${id}/models`);
    expect(await res.json()).toMatchObject({ error: { code: "unreachable" } });
  });

  it("answers 404 for an unknown provider", async () => {
    expect((await env.call("GET", "/api/providers/nope/models")).status).toBe(404);
  });
});
