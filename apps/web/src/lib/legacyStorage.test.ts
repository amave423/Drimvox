import { describe, expect, it } from "vitest";
import { moveLegacyStorage } from "./legacyStorage";

function storage(items: Record<string, string>) {
  const map = new Map(Object.entries(items));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

describe("what the window remembered before the rename", () => {
  it("moves the old keys to the new names, keeping what the new names already have", () => {
    const s = storage({ "artel.lastModel": '{"providerId":"p","model":"m"}', "artel.web": "free", "drimvox.web": "off", other: "x" });
    moveLegacyStorage(s);
    expect(Object.fromEntries(s.map)).toEqual({ "drimvox.lastModel": '{"providerId":"p","model":"m"}', "drimvox.web": "off", other: "x" });
  });
});
