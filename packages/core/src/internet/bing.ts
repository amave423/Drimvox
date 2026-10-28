import type { SearchResult, WebAccess } from "./web";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const MAX_RESULTS = 8;

/** Bing's results page: free, no key; the second search when DuckDuckGo asks for a pause. */
export async function bingSearch(query: string, signal?: AbortSignal, f: typeof fetch = fetch): Promise<SearchResult[]> {
  const timeout = AbortSignal.timeout(20_000);
  const res = await f(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ru`, {
    headers: { "User-Agent": UA, "Accept-Language": "ru,en;q=0.8" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`Bing answered ${res.status}`);
  const results = parseBing(await res.text());
  if (results.length === 0) throw new Error("Bing returned no results");
  return results;
}

/** Results of Bing's page; its own links are skipped, its redirects turned back into the real address. */
export function parseBing(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = realUrl(decode(link[1]!));
    if (!url) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    results.push({ title: plain(link[2]!), url, snippet: plain(snippet) });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

/** Bing hides addresses behind /ck/a?…&u=a1<base64>; the real one is inside. */
function realUrl(href: string): string | null {
  try {
    const u = new URL(href, "https://www.bing.com");
    if (u.hostname.endsWith("bing.com") && u.pathname === "/ck/a") {
      const coded = u.searchParams.get("u");
      if (!coded?.startsWith("a1")) return null;
      return realUrl(Buffer.from(coded.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    }
    if (u.hostname.endsWith("bing.com") || (u.protocol !== "http:" && u.protocol !== "https:")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const plain = (html: string) => decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;|&ensp;|&#160;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The free search with a second engine behind it (asked for: DuckDuckGo limited the searches again and again): when the
 * first fails, the second is asked; when both fail, the first one's reason goes to the model.
 */
export function withSecondSearch(first: WebAccess, second: (query: string, signal?: AbortSignal) => Promise<SearchResult[]>): WebAccess {
  return {
    ...first,
    search: async (query, signal) => {
      try {
        return await first.search(query, signal);
      } catch (err) {
        if (signal?.aborted || /no results/i.test(err instanceof Error ? err.message : "")) throw err;
        return second(query, signal).catch(() => {
          throw err;
        });
      }
    },
  };
}
