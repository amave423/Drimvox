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

  // Asked for: local models always thought their most; Ollama passes the effort to the model's template.
  it("tells Ollama and LM Studio the effort, and turns thinking off with none", () => {
    expect(thinkingOptions("ollama", "off")).toEqual({ ollama: { reasoningEffort: "none" } });
    expect(thinkingOptions("ollama", "medium")).toEqual({ ollama: { reasoningEffort: "medium" } });
    expect(thinkingOptions("lmstudio", "low")).toEqual({ lmstudio: { reasoningEffort: "low" } });
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

describe("thinking on a local model", () => {
  // Seen live: a Qwen 3.8 template took "low" and "medium" and refused "high"; the answer must still come.
  it("sends the level to Ollama, and asks again without it when the model refuses that level", async () => {
    const sent: any[] = [];
    fake = await startFakeProvider({
      key: KEY,
      models: [{ id: "qwen" }],
      chunks: [{ text: "391" }],
      handle: (method, path, body) => {
        if (method !== "POST" || !path.endsWith("/chat/completions")) return undefined;
        sent.push(body);
        if (body?.reasoning_effort === "high") return { status: 500, json: { error: { message: "Jinja Exception: Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low." } } };
        return undefined;
      },
    });
    env.setPresetUrl("ollama", `${fake.baseUrl}`);
    const provider = await (await env.call("POST", "/api/providers", { preset: "ollama", apiKey: KEY })).json();
    const c = await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "qwen" })).json();
    const events = await readEvents(await env.call("POST", `/api/chats/${c.id}/messages`, { content: "17*23?", thinking: "high" }));
    expect(events.at(-1).message).toMatchObject({ status: "done", content: "391" });
    expect(sent.map((b) => b.reasoning_effort ?? null)).toEqual(["high", null]);
    await readEvents(await env.call("POST", `/api/chats/${c.id}/messages`, { content: "Ещё", thinking: "off" }));
    expect(sent.at(-1).reasoning_effort).toBe("none");
  });
});

// Seen live: a chain went from DeepSeek to another provider mid-project and every request failed on the history's
// reasoning ("'messages.2': property 'reasoning_content' is unsupported").
describe("history reasoning a provider refuses", () => {
  it("asks again without the earlier answers' reasoning", async () => {
    const { withoutHistoryReasoning } = await import("../src/providers/model");
    const sent: any[] = [];
    const stub = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      return body.messages.some((m: any) => "reasoning_content" in m)
        ? new Response(JSON.stringify({ error: { message: "'messages.2' : property 'reasoning_content' is unsupported" } }), { status: 400 })
        : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const body = { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b", reasoning_content: "thought" }] };
    const res = await withoutHistoryReasoning(stub)("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1].messages[1]).toEqual({ role: "assistant", content: "b" });
  });
});
