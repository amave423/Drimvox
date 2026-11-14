import { describe, expect, it } from "vitest";
import { unfinished } from "../src/work/run";

describe("an answer that leaves the work unfinished", () => {
  it("is told by its own words, in Russian and English", () => {
    expect(unfinished("Работа **не завершена**, релиз не выпускал.")).toBe(true);
    expect(unfinished("The work is not finished: channels are left.")).toBe(true);
    expect(unfinished("Remaining work: emoji.")).toBe(true);
  });

  it("is not a finished answer naming what was not checked", () => {
    expect(unfinished("Готово. Не проверено вживую на телефоне.")).toBe(false);
    expect(unfinished("Done: nothing is broken, tests pass.")).toBe(false);
  });
});
