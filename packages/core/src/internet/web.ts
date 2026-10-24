import type { PageAction } from "@drimvox/shared";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface Page {
  url: string;
  title: string;
  text: string;
}

/** How Drimvox reaches the internet for models. Tests replace it with a fake. */
export interface WebAccess {
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
  open(url: string, signal?: AbortSignal): Promise<Page>;
  /**
   * Opens a page in a real browser, runs its scripts and the steps given, and reads what it shows. Absent where there is
   * no browser (tests without one); the desktop's hidden window or the server's Chromium otherwise.
   */
  render?(url: string, steps?: PageAction[], signal?: AbortSignal): Promise<Page>;
}

/** Reads a page in a real browser: what the desktop app and the server give the core. */
export type PageReader = (url: string, steps?: PageAction[]) => Promise<{ url: string; title: string; text: string }>;

/** A rendered page's text, as long as a fetched one may be. */
export function clipPage(text: string): string {
  const clean = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > MAX_PAGE_CHARS ? `${clean.slice(0, MAX_PAGE_CHARS)}\n…(the rest of the page is cut off)` : clean;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const MAX_RESULTS = 8;
const MAX_PAGE_BYTES = 3_000_000;
const MAX_PAGE_CHARS = 20_000;
const MAX_REDIRECTS = 5;

/** Searches this far apart at least: DuckDuckGo answers a burst with a bot check. */
const SEARCH_GAP_MS = 1_500;
/** Pauses after DuckDuckGo asked for one (HTTP 202 with a bot check), before trying again. */
const BACKOFF_MS = [5_000, 15_000];
/** After the pauses did not help, how long searches answer "limited" without asking DuckDuckGo at all. */
const COOLDOWN_MS = 120_000;
const LIMITED = "Web search is temporarily limited by DuckDuckGo. Wait a minute before searching again, or go on with what you know.";

export interface SearchClock {
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * DuckDuckGo's HTML results: free, no key. One search at a time for the whole app, kept apart; when DuckDuckGo
 * asks for a pause Drimvox waits and tries again, and never tries to get past its check.
 */
export function makeDuckDuckGo(clock: SearchClock): WebAccess {
  let queue: Promise<unknown> = Promise.resolve();
  let last = -Infinity;
  let limitedUntil = -Infinity;

  async function once(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    if (clock.now() < limitedUntil) throw new Error(LIMITED);
    for (let attempt = 0; ; attempt++) {
      const wait = last + SEARCH_GAP_MS - clock.now();
      if (wait > 0) await clock.sleep(wait);
      last = clock.now();
      const res = await clock.fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": UA, "Accept-Language": "ru,en;q=0.8" },
        signal: anySignal(signal, 20_000),
      });
      const html = await res.text();
      if (res.status === 202) {
        const pause = BACKOFF_MS[attempt];
        if (pause === undefined) {
          limitedUntil = clock.now() + COOLDOWN_MS;
          throw new Error(LIMITED);
        }
        await clock.sleep(pause);
        // The pause already keeps this try apart from the last one.
        last = clock.now() - SEARCH_GAP_MS;
        continue;
      }
      if (!res.ok) throw new Error(`Search answered ${res.status}`);
      const results = parseSearch(html);
      if (results.length === 0) throw new Error("The search returned no results; try other words.");
      return results;
    }
  }

  return {
    search(query, signal) {
      const run = queue.then(() => once(query, signal));
      queue = run.catch(() => undefined);
      return run;
    },
    open: openPage,
  };
}

export const duckDuckGo: WebAccess = makeDuckDuckGo({
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/** One page as text: public addresses only, every redirect checked too. */
async function openPage(url: string, signal?: AbortSignal): Promise<Page> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(target);
    const res = await fetch(target, {
      headers: { "User-Agent": UA, Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
      redirect: "manual",
      signal: anySignal(signal, 20_000),
    });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      // Every hop is checked: a public page must not bounce the model onto this computer's network.
      target = new URL(next, target).toString();
      continue;
    }
    if (!res.ok) throw new Error(`The page answered ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/|json|xml/.test(type)) throw new Error(`Not a text page (${type || "unknown type"})`);
    const body = await readLimited(res, MAX_PAGE_BYTES);
    if (/html/.test(type)) return { url: target, ...pageText(body) };
    return { url: target, title: "", text: clip(body.trim()) };
  }
  throw new Error("Too many redirects");
}

/** Results of DuckDuckGo's HTML page; ads and results without an address are skipped. */
export function parseSearch(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div class="result[ "]/).slice(1);
  for (const block of blocks) {
    if (/result--ad/.test(block.slice(0, 200))) continue;
    const link = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = realUrl(decode(link[1]!));
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snippet = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
    results.push({ title: inline(link[2]!), url, snippet: inline(snippet) });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

/** The readable text of a page: no scripts, styles or markup, one line per block. */
export function pageText(html: string): { title: string; text: string } {
  const title = inline(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const body = html
    .replace(/<head[\s\S]*?<\/head>/i, " ")
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|li|tr|section|article|header|footer|nav|main|aside|ul|ol|table|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text: clip(text) };
}

/** True for http(s) addresses outside this computer and its local network, by the address itself. */
export function isPublicAddress(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  return isIP(host) ? !isPrivateIp(host) : host.includes(".");
}

async function assertPublic(url: string): Promise<void> {
  if (!isPublicAddress(url)) throw new Error("Only public internet addresses can be opened");
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  // A public name may still point at this computer.
  const addresses = await lookup(host, { all: true });
  if (addresses.some((a) => isPrivateIp(a.address))) throw new Error("Only public internet addresses can be opened");
}

function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(v6);
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function realUrl(href: string): string | null {
  const full = href.startsWith("//") ? `https:${href}` : href;
  try {
    const u = new URL(full);
    if (u.hostname.endsWith("duckduckgo.com") && u.pathname === "/l/") return u.searchParams.get("uddg");
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function inline(html: string): string {
  return decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", deg: "°", hellip: "…", laquo: "«", raquo: "»", copy: "©" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function clip(text: string): string {
  return text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n…(the rest of the page is cut off)` : text;
}

async function readLimited(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size >= max) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function anySignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
