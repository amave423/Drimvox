import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { fetchBalance } from "../src/providers/balance";
import { normalizeModels } from "../src/providers/catalog";
import { createCipher } from "../src/secrets";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

let fake: FakeProvider | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("normalizeModels", () => {
  it("reads OpenRouter prices, context and tool support", () => {
    const [model] = normalizeModels("openrouter", [
      {
        id: "deepseek/deepseek-chat",
        name: "DeepSeek: V3",
        context_length: 163840,
        pricing: { prompt: "0.0000003", completion: "0.00000088" },
        supported_parameters: ["tools", "temperature"],
      },
    ]);
    expect(model).toEqual({
      id: "deepseek/deepseek-chat",
      name: "DeepSeek: V3",
      contextLength: 163840,
      priceIn: 0.3,
      priceOut: 0.88,
      priceEstimated: false,
      tools: true,
    });
  });

  it("uses the built-in price table for DeepSeek and marks it as an estimate", () => {
    const [model] = normalizeModels("deepseek", [{ id: "deepseek-chat" }]);
    expect(model).toMatchObject({ id: "deepseek-chat", priceEstimated: true });
    expect(model?.priceIn).toBeGreaterThan(0);
  });

  it("prices local models at zero", () => {
    expect(normalizeModels("ollama", [{ id: "qwen3:8b" }])[0]).toMatchObject({ priceIn: 0, priceOut: 0 });
  });

  it("leaves prices unknown when the provider does not publish them", () => {
    expect(normalizeModels("nvidia", [{ id: "meta/llama-3.3-70b-instruct" }])[0]).toMatchObject({
      priceIn: null,
      priceOut: null,
      tools: null,
    });
  });

  it("sorts by name and drops entries without an id", () => {
    const models = normalizeModels("custom", [{ id: "b" }, { name: "no id" }, { id: "a" }]);
    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("fetchBalance", () => {
  it("reads OpenRouter credits minus usage", async () => {
    fake = await startFakeProvider({ routes: { "/v1/credits": { data: { total_credits: 10, total_usage: 2.5 } } } });
    expect(await fetchBalance("openrouter", fake.baseUrl, "k")).toEqual({ amount: 7.5, currency: "USD" });
  });

  it("reads the DeepSeek balance in dollars", async () => {
    fake = await startFakeProvider({
      routes: {
        "/user/balance": {
          is_available: true,
          balance_infos: [
            { currency: "CNY", total_balance: "70.00" },
            { currency: "USD", total_balance: "4.20" },
          ],
        },
      },
    });
    expect(await fetchBalance("deepseek", fake.baseUrl, "k")).toEqual({ amount: 4.2, currency: "USD" });
  });

  it("has no balance for providers without such an API", async () => {
    expect(await fetchBalance("nvidia", "https://integrate.api.nvidia.com/v1", "k")).toBeNull();
  });
});

describe("secrets", () => {
  it("round-trips and never stores plain text", () => {
    const cipher = createCipher(randomBytes(32));
    const blob = cipher.encrypt("sk-secret");
    expect(blob).not.toContain("sk-secret");
    expect(cipher.decrypt(blob)).toBe("sk-secret");
  });

  it("refuses to decrypt with another key", () => {
    const blob = createCipher(randomBytes(32)).encrypt("sk-secret");
    expect(() => createCipher(randomBytes(32)).decrypt(blob)).toThrow();
  });

  it("refuses a key of the wrong size", () => {
    expect(() => createCipher(randomBytes(16))).toThrow();
  });
});
