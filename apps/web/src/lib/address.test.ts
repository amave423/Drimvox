import { describe, expect, it } from "vitest";
import { addressOf } from "./address";

describe("the browser's address field", () => {
  it("opens an address as it is, adding https:// or http:// for this computer", () => {
    expect(addressOf("example.com/a", "ru")).toBe("https://example.com/a");
    expect(addressOf("localhost:5173", "ru")).toBe("http://localhost:5173");
    expect(addressOf("https://x.test/", "ru", "google")).toBe("https://x.test/");
  });

  // Asked for: a choice of the search engine instead of Yandex alone.
  it("searches words with the chosen engine, Yandex or Bing by the language when left to itself", () => {
    expect(addressOf("доски сосна", "ru")).toBe("https://yandex.ru/search/?text=%D0%B4%D0%BE%D1%81%D0%BA%D0%B8%20%D1%81%D0%BE%D1%81%D0%BD%D0%B0");
    expect(addressOf("pine boards", "en")).toBe("https://www.bing.com/search?q=pine%20boards");
    expect(addressOf("pine boards", "ru", "google")).toBe("https://www.google.com/search?q=pine%20boards");
    expect(addressOf("pine boards", "ru", "duckduckgo")).toBe("https://duckduckgo.com/?q=pine%20boards");
    expect(addressOf("pine boards", "en", "yandex")).toBe("https://yandex.ru/search/?text=pine%20boards");
  });
});
