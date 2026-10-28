import { describe, expect, it } from "vitest";
import { parseBing, withSecondSearch } from "../src/internet/bing";
import { isPublicAddress, makeDuckDuckGo, pageText, parseSearch, type WebAccess } from "../src/internet/web";

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

const BING = `
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1${Buffer.from("https://wttr.in/Moscow").toString("base64url")}&amp;ntb=1">Погода в <strong>Москве</strong></a></h2>
<div class="b_caption"><p>+5&#176;C, облачно &amp; ветрено</p></div></li>
<li class="b_algo"><h2><a href="https://example.org/direct">Direct</a></h2><p>Second</p></li>
<li class="b_algo"><h2><a href="https://www.bing.com/images/search?q=x">Images</a></h2></li>`;

// Asked for: the free search must not stop at DuckDuckGo's limit.
describe("the second search", () => {
  it("reads Bing's results, its hidden addresses turned back into real ones", () => {
    expect(parseBing(BING)).toEqual([
      { title: "Погода в Москве", url: "https://wttr.in/Moscow", snippet: "+5°C, облачно & ветрено" },
      { title: "Direct", url: "https://example.org/direct", snippet: "Second" },
    ]);
  });

  it("asks Bing when DuckDuckGo is limited, and gives DuckDuckGo's reason when both fail", async () => {
    const limited: WebAccess = { search: async () => Promise.reject(new Error("Web search is temporarily limited.")), open: async () => ({ url: "", title: "", text: "" }) };
    const found = [{ title: "B", url: "https://b.example/", snippet: "" }];
    expect(await withSecondSearch(limited, async () => found).search("q")).toEqual(found);
    await expect(withSecondSearch(limited, async () => Promise.reject(new Error("Bing answered 403"))).search("q")).rejects.toThrow(/temporarily limited/);
  });
});

// Seen live: searches in a row got DuckDuckGo's bot check (HTTP 202), and the agent was told to "try other words".
describe("search pacing", () => {
  const page = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/html" } });
  const fakeClock = () => {
    let now = 0;
    const waits: number[] = [];
    return { now: () => now, sleep: async (ms: number) => void (waits.push(ms), (now += ms)), waits };
  };

  it("slows down and tries again when DuckDuckGo asks for a pause", async () => {
    const answers = [page(202, "challenge"), page(202, "challenge"), page(200, DDG)];
    const clock = fakeClock();
    const search = makeDuckDuckGo({ fetch: async () => answers.shift()!, ...clock });
    expect(await search.search("кофейня меню")).toHaveLength(2);
    expect(clock.waits).toEqual([5_000, 15_000]);
  });

  it("keeps searches apart instead of firing them in a burst", async () => {
    const clock = fakeClock();
    const search = makeDuckDuckGo({ fetch: async () => page(200, DDG), ...clock });
    await search.search("one");
    await search.search("two");
    expect(clock.waits).toEqual([1_500]);
  });

  it("says the search is limited, not that nothing exists, and stops knocking for a while", async () => {
    const clock = fakeClock();
    let asked = 0;
    const search = makeDuckDuckGo({ fetch: async () => (asked++, page(202, "challenge")), ...clock });
    await expect(search.search("погода")).rejects.toThrow(/temporarily limited/);
    expect(asked).toBe(3);
    await expect(search.search("ещё")).rejects.toThrow(/temporarily limited/);
    expect(asked).toBe(3);
    await clock.sleep(120_000);
    await expect(search.search("позже")).rejects.toThrow(/temporarily limited/);
    expect(asked).toBe(6);
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
