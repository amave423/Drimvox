import { describe, expect, it } from "vitest";
import { isPublicAddress, pageText, parseSearch } from "../src/internet/web";

const DDG = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwttr.in%2FMoscow&amp;rut=abc">Weather in <b>Moscow</b></a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwttr.in%2FMoscow">Forecast: +5 &deg;C, cloudy &amp; windy</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.org/direct">Direct link</a></h2>
  <a class="result__snippet">Second result</a>
</div>
<div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads">Ad</a></div>`;

describe("search results", () => {
  it("reads titles, real addresses and snippets, skipping ads", () => {
    expect(parseSearch(DDG)).toEqual([
      { title: "Weather in Moscow", url: "https://wttr.in/Moscow", snippet: "Forecast: +5 °C, cloudy & windy" },
      { title: "Direct link", url: "https://example.org/direct", snippet: "Second result" },
    ]);
  });
});

describe("pages", () => {
  it("keeps the readable text of a page", () => {
    const html = `<html><head><title>Погода &mdash; Москва</title><style>p{color:red}</style><script>alert(1)</script></head>
      <body><nav>Меню</nav><h1>Москва</h1><p>Сейчас +5&nbsp;°C,<br>облачно.</p><p>Ветер 3 м/с</p></body></html>`;
    expect(pageText(html)).toEqual({ title: "Погода — Москва", text: "Меню\nМосква\nСейчас +5 °C,\nоблачно.\nВетер 3 м/с" });
  });

  it("opens only public addresses", () => {
    expect(isPublicAddress("https://wttr.in/Moscow")).toBe(true);
    for (const url of [
      "http://127.0.0.1:5173/api/settings",
      "http://localhost/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "file:///C:/Windows/win.ini",
      "http://printer.local/",
    ]) {
      expect(isPublicAddress(url), url).toBe(false);
    }
  });
});
