import { describe, expect, it } from "vitest";
import { freeFirst, isFree } from "./models";

const m = (id: string, priceIn: number | null, priceOut: number | null) => ({ id, priceIn, priceOut });

describe("freeFirst", () => {
  it("puts free models first when the list has both", () => {
    const list = [m("gpt", 1, 2), m("qwen:free", 0, 0), m("claude", 3, 15), m("llama:free", 0, 0)];
    expect(freeFirst(list, isFree)).toEqual({ free: [list[1], list[3]], paid: [list[0], list[2]] });
  });

  it("does not split a list where everything or nothing is free", () => {
    expect(freeFirst([m("a", 0, 0), m("b", 0, 0)], isFree)).toBeNull();
    expect(freeFirst([m("a", 1, 1), m("b", null, null)], isFree)).toBeNull();
  });

  it("does not take an unknown price for free", () => {
    expect(isFree(m("x", null, null))).toBe(false);
    expect(isFree(m("x", 0, 1))).toBe(false);
  });
});
