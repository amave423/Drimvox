import { speechText } from "@drimvox/shared";
import { describe, expect, it } from "vitest";

// Asked for: the voice read out emoji, code and symbols.
describe("the words of an answer to read aloud", () => {
  it("leaves out emoji, code, addresses, Markdown and symbols, keeping the words and the pauses", () => {
    const answer = [
      "## План 🚀",
      "",
      "Вот что сделаем → быстро ✅:",
      "- **Первый экран** — фото террасы 😊",
      "- Меню с ценами, подробнее [на сайте](https://example.com/menu)",
      "",
      "| Блок | Зачем |",
      "|---|---|",
      "| Карта | как дойти |",
      "",
      "```css",
      ":root { --sea: #2b6f8f; }",
      "```",
      "Команда `npm run dev` запускает сайт: http://localhost:5173 👍",
    ].join("\n");
    const said = speechText(answer);
    expect(said).not.toMatch(/[🚀✅😊👍→#*`|{}]/u);
    expect(said).not.toMatch(/npm run dev|localhost|example\.com|--sea/);
    expect(said).toContain("План");
    expect(said).toContain("Вот что сделаем быстро");
    expect(said).toContain("Первый экран — фото террасы");
    expect(said).toContain("на сайте");
    expect(said).toContain("Карта, как дойти");
    expect(said).toContain("Команда запускает сайт");
  });
});
