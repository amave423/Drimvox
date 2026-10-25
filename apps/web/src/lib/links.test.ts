import { describe, expect, it } from "vitest";
import { splitLinks } from "./links";

describe("web addresses in plain text", () => {
  it("are cut out, without the punctuation after them, and the text joins back unchanged", () => {
    const text = "Смотри https://github.com/amave423/Orqen-Studio, и ещё (https://example.com/a?b=1).";
    const parts = splitLinks(text);
    expect(parts.filter((p) => p.url).map((p) => p.url)).toEqual(["https://github.com/amave423/Orqen-Studio", "https://example.com/a?b=1"]);
    expect(parts.map((p) => p.text).join("")).toBe(text);
  });

  it("leaves text without addresses as one part", () => {
    expect(splitLinks("просто текст")).toEqual([{ text: "просто текст" }]);
  });
});
