import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const before = fake!.requests.filter((r) => r.body?.model === "first-free").length;
    await ask(chat.id, "Ещё");
    expect(fake!.requests.filter((r) => r.body?.model === "first-free").length).toBe(before);
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
    expect(fake!.requests.some((r) => r.body?.model === "second-free")).toBe(false);
  });
});
