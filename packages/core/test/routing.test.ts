import { describe, expect, it } from "vitest";
import { cheapestEndpoint, pinnedRates, unpinCheapest, withCheapestProvider } from "../src/providers/routing";

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
    // Its prices are known now: what the steps are billed at (per token, in the router's money).
    expect(pinnedRates("https://router.test/api/v1", "deepseek/flash")).toEqual({ input: 2.6 / 1e6, cached: 0.47 / 1e6, output: 47.3 / 1e6 });
    expect(pinnedRates("https://router.test/api/v1", "other/model")).toBeNull();
    expect((sent[0]!.body as { provider: { allow_fallbacks?: boolean } }).provider.allow_fallbacks).toBeUndefined();
    expect(sent[1]!.body).not.toHaveProperty("provider");
  });

  // Seen live: four tries in a row waited two minutes each for one provider of DeepSeek 1017.
  it("leaves the choice to the router for a while once the cheapest one failed", async () => {
    const sent: unknown[] = [];
    const fake: typeof fetch = async (input, init) => {
      if (String(input).includes("/endpoints")) return new Response(JSON.stringify({ data: { endpoints: [endpoint("morph", 2.6, 0.47, 47.3)] } }));
      sent.push(JSON.parse(String(init?.body)));
      return new Response("{}");
    };
    const routed = withCheapestProvider("https://stuck.test/api/v1", fake);
    const ask = () => routed("https://stuck.test/api/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "deepseek/flash", messages: [] }) });
    await ask();
    unpinCheapest("https://stuck.test/api/v1", "deepseek/flash");
    await ask();
    unpinCheapest("https://stuck.test/api/v1", "deepseek/flash", -1);
    await ask();
    expect(sent.map((b) => (b as { provider?: unknown }).provider ?? null)).toEqual([{ order: ["morph"] }, null, { order: ["morph"] }]);
  });

  // Seen live: a screenshot sent where the router chose cost 1.20 ₽ a step against 0.10 ₽. The cheapest provider first;
  // the router only when that one refuses pictures.
  it("sends a screenshot to the cheapest provider too, and to the router only when that one refuses it", async () => {
    const sent: { provider?: unknown }[] = [];
    let takesPictures = true;
    const fake: typeof fetch = async (input, init) => {
      if (String(input).includes("/endpoints")) return new Response(JSON.stringify({ data: { endpoints: [endpoint("morph", 2.6, 0.47, 47.3)] } }));
      const body = JSON.parse(String(init?.body)) as { provider?: unknown };
      sent.push(body);
      return body.provider && !takesPictures ? new Response('{"error":{"message":"image input not supported"}}', { status: 400 }) : new Response("{}");
    };
    const routed = withCheapestProvider("https://eyes.test/api/v1", fake);
    const picture = { method: "POST", body: JSON.stringify({ model: "deepseek/flash", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] }) };
    expect((await routed("https://eyes.test/api/v1/chat/completions", picture)).ok).toBe(true);
    expect(sent.map((b) => b.provider ?? null)).toEqual([{ order: ["morph"] }]);
    takesPictures = false;
    expect((await routed("https://eyes.test/api/v1/chat/completions", picture)).ok).toBe(true);
    expect(sent.slice(1).map((b) => b.provider ?? null)).toEqual([{ order: ["morph"] }, null]);
  });
});
