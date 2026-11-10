import { describe, expect, it } from "vitest";
import { cheapestEndpoint, withCheapestProvider } from "../src/providers/routing";

const endpoint = (tag: string, prompt: number, cache: number | null, completion: number, extra: Record<string, unknown> = {}) => ({
  tag,
  status: 0,
  supported_parameters: ["tools"],
  pricing: { prompt: prompt / 1e6, completion: completion / 1e6, ...(cache === null ? {} : { input_cache_read: cache / 1e6 }) },
  ...extra,
});

// Seen live: RouterAI spread one conversation over its 48 providers of DeepSeek 1017, priced 0.71 to 269 ₽ per million
// input tokens, each with a cache of its own; steps cost up to seven times one another and the cache came and went.
describe("the cheapest provider of a model", () => {
  it("weighs an agent's tokens, mostly read from the cache, and skips the slow, the down and those without tools", () => {
    const list = [
      endpoint("fireworks", 35.5, 0.71, 142),
      endpoint("morph", 2.6, 0.47, 47.3),
      endpoint("relace", 0.71, 0.59, 59.2),
      endpoint("sail-research", 11.95, 0.8, 17.75, { status: -5 }),
      endpoint("particle-ai/flex", 2.96, 0.18, 29.6),
      endpoint("no-tools", 0.1, 0.01, 0.1, { supported_parameters: ["temperature"] }),
      // Without a cache price every input token is a new one.
      endpoint("no-cache", 5, null, 10),
    ];
    expect(cheapestEndpoint(list)).toBe("morph");
  });

  it("pins the request to it, keeps the fallbacks, and leaves a request alone when the list cannot be had", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models/deepseek/flash/endpoints")) return new Response(JSON.stringify({ data: { endpoints: [endpoint("morph", 2.6, 0.47, 47.3), endpoint("fireworks", 35.5, 0.71, 142)] } }));
      if (url.includes("/endpoints")) return new Response("not found", { status: 404 });
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("{}");
    };
    const routed = withCheapestProvider("https://router.test/api/v1", fake);
    await routed("https://router.test/api/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "deepseek/flash", messages: [] }) });
    await routed("https://router.test/api/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "other/model", messages: [] }) });
    expect(sent[0]!.body).toMatchObject({ model: "deepseek/flash", provider: { order: ["morph"] } });
    expect((sent[0]!.body as { provider: { allow_fallbacks?: boolean } }).provider.allow_fallbacks).toBeUndefined();
    expect(sent[1]!.body).not.toHaveProperty("provider");
  });
});
