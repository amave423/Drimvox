import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetAvailability } from "../src/providers/availability";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

// docs/specs/model-chains.md: free models in turn under one name; one that hit its limit rests, the next answers.
const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider | undefined;

beforeEach(() => {
  env = createTestEnv();
});
afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
});

const free = { prompt: "0", completion: "0" };
const chain = (providerId: string, models: string[], extra: Record<string, unknown> = {}) => ({
  id: "mine",
  name: "Мой код бесплатно",
  models: models.map((model) => ({ providerId, model })),
  order: "list",
  onLimit: true,
  onError: true,
  timeoutS: 20,
  toolsOnly: false,
  ...extra,
});

async function setup(respond: (model: string) => { text?: string; fail?: { status: number; message: string } }) {
  fake = await startFakeProvider({
    key: KEY,
    models: [
      { id: "first-free", pricing: free, supported_parameters: ["tools"] },
      { id: "second-free", pricing: free, supported_parameters: ["tools"] },
      { id: "paid", pricing: { prompt: "0.000001", completion: "0.000002" } },
    ],
    respond: (body) => respond(body.model),
  });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  return provider.id as string;
}

const ask = async (chatId: string, content: string) => readEvents(await env.call("POST", `/api/chats/${chatId}/messages`, { content }));

describe("chains of free models", () => {
  it("answers through the next model when the first hit its limit, and the first rests", async () => {
    const id = await setup((model) => (model === "first-free" ? { fail: { status: 429, message: "Rate limit" } } : { text: `Ответила ${model}` }));
    expect((await env.call("PUT", "/api/chains", [chain(id, ["first-free", "second-free"])])).status).toBe(200);
    const chat = await (await env.call("POST", "/api/chats", { providerId: "chain", model: "mine" })).json();
    await ask(chat.id, "Привет");
    const saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
    expect(saved.messages.at(-1)).toMatchObject({ role: "assistant", status: "done", content: "Ответила second-free" });

    const views = await (await env.call("GET", "/api/chains")).json();
    const mine = views.find((c: any) => c.id === "mine");
    expect(mine.members.map((m: any) => m.state)).toEqual(["resting", "ok"]);
    expect(mine.answered).toBe("Fake / second-free");
    // The next question skips the resting one.
    const before = fake!.requests.filter((r) => r.body?.model === "first-free" && r.body?.stream !== false).length;
    await ask(chat.id, "Ещё");
    expect(fake!.requests.filter((r) => r.body?.model === "first-free" && r.body?.stream !== false).length).toBe(before);
  });

  // Seen with OpenRouter: some free models are closed to ordinary accounts and refuse at once; the chain goes on.
  it("goes on past a model that refuses this account outright", async () => {
    const id = await setup((model) => (model === "first-free" ? { fail: { status: 403, message: "Not available for free users" } } : { text: "Ответила вторая" }));
    await env.call("PUT", "/api/chains", [chain(id, ["first-free", "second-free"])]);
    const chat = await (await env.call("POST", "/api/chats", { providerId: "chain", model: "mine" })).json();
    await ask(chat.id, "Привет");
    const saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
    expect(saved.messages.at(-1)).toMatchObject({ status: "done", content: "Ответила вторая" });
  });

  it("makes its own chains from the free models only, and lists every chain as a free model", async () => {
    const id = await setup(() => ({ text: "Да" }));
    const views = await (await env.call("GET", "/api/chains")).json();
    const auto = views.find((c: any) => c.id === "auto-code");
    expect(auto).toMatchObject({ auto: true, toolsOnly: true });
    expect(auto.members.map((m: any) => m.model).sort()).toEqual(["first-free", "second-free"]);
    const models = await (await env.call("GET", "/api/providers/chain/models")).json();
    expect(models.map((m: any) => m.id)).toEqual(expect.arrayContaining(["auto-code", "auto-chat"]));
    expect(models.every((m: any) => m.priceIn === 0)).toBe(true);
    // Drimvox's own chains are not saved over.
    await env.call("PUT", "/api/chains", [chain(id, ["first-free"], { id: "auto-code", name: "x" })]);
    expect((await (await env.call("GET", "/api/chains")).json()).filter((c: any) => c.id === "auto-code")[0].name).toBe("Авто: для кода");
  });

  it("does not go on when the rules say not to, and says the model's error", async () => {
    const id = await setup((model) => (model === "first-free" ? { fail: { status: 429, message: "Rate limit" } } : { text: "Да" }));
    await env.call("PUT", "/api/chains", [chain(id, ["first-free", "second-free"], { onLimit: false })]);
    const chat = await (await env.call("POST", "/api/chats", { providerId: "chain", model: "mine" })).json();
    await ask(chat.id, "Привет");
    const saved = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
    expect(saved.messages.at(-1).status).toBe("error");
    expect(fake!.requests.some((r) => r.body?.model === "second-free" && r.body?.stream !== false)).toBe(false);
  });

  // Seen: one provider that never answered held the chains' tabs for 30-40 seconds.
  it("opens at once from the kept list while a slow provider is waited for a few seconds at most", { timeout: 30_000 }, async () => {
    const id = await setup(() => ({ text: "Да" }));
    const hang = createServer(() => {});
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    try {
      await env.call("POST", "/api/providers", { preset: "custom", name: "Slow", baseUrl: `http://127.0.0.1:${(hang.address() as AddressInfo).port}/v1`, apiKey: "k" });
      let started = Date.now();
      const first = await (await env.call("GET", "/api/chains/free")).json();
      expect(Date.now() - started).toBeLessThan(12_000);
      expect(first.map((m: any) => m.model).sort()).toEqual(["first-free", "second-free"]);
      started = Date.now();
      await env.call("GET", "/api/chains");
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(first.every((m: any) => m.providerId === id)).toBe(true);
    } finally {
      hang.closeAllConnections();
      await new Promise((r) => hang.close(r));
    }
  });

  it("asks the free models a word on request and shows each one's state; a flat-fee provider's models are free too", async () => {
    const id = await setup((model) => (model === "first-free" ? { fail: { status: 429, message: "Busy" } } : { text: "Да" }));
    const flat = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Flat", baseUrl: fake!.baseUrl, apiKey: KEY })).json();
    expect((await env.call("PATCH", `/api/providers/${flat.id}`, { flat: true })).status).toBe(200);
    expect((await env.call("POST", "/api/chains/check")).status).toBe(202);
    let free: any[] = [];
    for (let i = 0; i < 100; i++) {
      free = await (await env.call("GET", "/api/chains/free")).json();
      if (free.length && free.every((m) => m.check.state !== "checking" && m.check.state !== "unknown")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const of = (pid: string, model: string) => free.find((m) => m.providerId === pid && m.model === model);
    expect(of(id, "first-free").check.state).toBe("busy");
    expect(of(id, "second-free").check).toMatchObject({ state: "ok", ms: expect.any(Number) });
    // The flat provider's paid model is free to Drimvox: it is offered and checked like the free ones.
    expect(of(flat.id, "paid")).toMatchObject({ flat: true });
    // The probe asks for one word only.
    const probes = fake!.requests.filter((r) => r.path === "/v1/chat/completions" && r.body?.stream === false);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((r) => r.body.max_tokens === 1)).toBe(true);
  });

  // Seen with Gemini: models Google no longer serves to new users looked fine again after every restart.
  it("remembers which free models answer across a restart", async () => {
    const id = await setup((model) => (model === "first-free" ? { fail: { status: 404, message: "no longer available to new users" } } : { text: "Да" }));
    await env.call("POST", "/api/chains/check");
    let free: any[] = [];
    for (let i = 0; i < 100; i++) {
      free = await (await env.call("GET", "/api/chains/free")).json();
      if (free.length && free.every((m) => m.check.state !== "checking" && m.check.state !== "unknown")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(free.find((m: any) => m.model === "second-free").check.state).toBe("ok");
    forgetAvailability();
    env.reopen();
    const models = await (await env.call("GET", `/api/providers/${id}/models`)).json();
    const listed = (models.models ?? models) as { id: string; available?: string }[];
    expect(listed.find((m) => m.id === "first-free")?.available).toBe("gone");
    expect(listed.find((m) => m.id === "second-free")?.available).toBe("ok");
  });
});
