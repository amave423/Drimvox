import { describe, expect, it } from "vitest";
import { moneyByKind } from "../ui/projects/WorkTokens";

// Asked for: what reading, the cache apart from it and writing each cost, at what rate.
describe("the money of each kind of token", () => {
  const work = (spentUsd: number, rates: { input: number; cached: number; output: number } | null) => ({
    tokens: { input: 1_000_000, cached: 800_000, output: 50_000, context: null },
    rates,
    spentUsd,
  });

  it("counts the cache apart from new reading, by the rates, fitted to the provider's bill", () => {
    // By the rates: new 200k × $1 = 0.2, cache 800k × $0.1 = 0.08, writing 50k × $2 = 0.1, together 0.38; billed 0.76.
    const [fresh, cached, out] = moneyByKind(work(0.76, { input: 1, cached: 0.1, output: 2 }));
    expect(fresh).toMatchObject({ tokens: 200_000, rate: 1 });
    expect(cached).toMatchObject({ tokens: 800_000, rate: 0.1 });
    expect(out).toMatchObject({ tokens: 50_000, rate: 2 });
    expect(fresh!.money).toBeCloseTo(0.4);
    expect(cached!.money).toBeCloseTo(0.16);
    expect(out!.money).toBeCloseTo(0.2);
    expect(fresh!.money! + cached!.money! + out!.money!).toBeCloseTo(0.76);
  });

  it("shows only the tokens when the rates are unknown", () => {
    expect(moneyByKind(work(0.5, null)).map((r) => [r.tokens, r.money, r.rate])).toEqual([
      [200_000, null, null],
      [800_000, null, null],
      [50_000, null, null],
    ]);
  });
});
