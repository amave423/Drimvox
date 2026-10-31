import { describe, expect, it } from "vitest";
import { speechChunks } from "./recorder";

// Seen: a whole answer was voiced first and nothing was heard for twenty seconds, as if it had hung.
describe("speech in pieces", () => {
  it("starts with a short piece and keeps sentences whole", () => {
    const text = "Первое предложение. " + "Это длинное предложение для проверки разбиения на части. ".repeat(12);
    const chunks = speechChunks(text);
    expect(chunks[0]!.length).toBeLessThanOrEqual(140);
    expect(chunks[0]!.startsWith("Первое предложение.")).toBe(true);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => /[.!?…]$/.test(c))).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.trim().replace(/\s+/g, " "));
  });

  it("gives a short text as one piece", () => {
    expect(speechChunks("Привет!")).toEqual(["Привет!"]);
  });
});
