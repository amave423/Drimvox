import { describe, expect, it } from "vitest";
import { formatPrice, formatTokens, formatUsd, startOfToday } from "./format";
import { createSseParser } from "./sse";

describe("formatUsd", () => {
  it("keeps fractions of a cent readable", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00004)).toBe("< $0.0001");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(3.5)).toBe("$3.50");
  });
});

describe("formatTokens", () => {
  it("shortens thousands in each language", () => {
    expect(formatTokens(950, "ru")).toBe("950");
    expect(formatTokens(12_345, "ru")).toBe("12,3 тыс.");
    expect(formatTokens(12_345, "en")).toBe("12.3k");
    expect(formatTokens(2000, "en")).toBe("2k");
    expect(formatTokens(163_840, "ru")).toBe("164 тыс.");
  });
});

describe("formatPrice", () => {
  it("shows prices per 1M tokens", () => {
    expect(formatPrice(0)).toBe("$0");
    expect(formatPrice(0.28)).toBe("$0.28");
    expect(formatPrice(0.3)).toBe("$0.30");
    expect(formatPrice(15)).toBe("$15");
    expect(formatPrice(0.0035)).toBe("$0.0035");
  });
});

describe("startOfToday", () => {
  it("returns local midnight", () => {
    const at = new Date(2026, 9, 12, 15, 30);
    expect(startOfToday(at)).toBe(new Date(2026, 9, 12).getTime());
  });
});

describe("sse parser", () => {
  it("joins events split across chunks", () => {
    const parse = createSseParser<{ n: number }>();
    expect(parse('data: {"n":1}\n\ndata: {"n"')).toEqual([{ n: 1 }]);
    expect(parse(":2}\n")).toEqual([]);
    expect(parse("\n")).toEqual([{ n: 2 }]);
  });

  it("ignores comments and event names", () => {
    const parse = createSseParser<{ ok: boolean }>();
    expect(parse(': ping\n\nevent: x\ndata: {"ok":true}\n\n')).toEqual([{ ok: true }]);
  });
});
