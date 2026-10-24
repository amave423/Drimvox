import type { SearchCheck, SearchService, SearchView } from "@drimvox/shared";
import type { Database } from "../db";
import type { Cipher } from "../secrets";
import type { SearchResult, WebAccess } from "./web";

/** Kept next to the settings, encrypted: the key is the user's money. */
const KEY = "search";
const MAX_RESULTS = 8;

export interface SearchUrls {
  tavily: string;
  brave: string;
}
export const SEARCH_URLS: SearchUrls = {
  tavily: "https://api.tavily.com/search",
  brave: "https://api.search.brave.com/res/v1/web/search",
};

/** A search service's refusal, by kind: the interface says what to do about each. */
export class SearchFailure extends Error {
  constructor(
    readonly code: "auth" | "limit" | "failed",
    detail: string,
  ) {
    super(detail);
  }
}

/** The search service and its key from the settings (docs/specs/web-search.md). */
export class SearchStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher,
  ) {}

  get(): { service: Exclude<SearchService, "free">; key: string } | null {
    const row = this.db.sql.prepare("select value from settings where key = ?").get(KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(this.cipher.decrypt(JSON.parse(row.value) as string));
    } catch {
      return null;
    }
  }

  set(value: { service: Exclude<SearchService, "free">; key: string } | null): void {
    if (value === null) this.db.sql.prepare("delete from settings where key = ?").run(KEY);
    else {
      this.db.sql
        .prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
        .run(KEY, JSON.stringify(this.cipher.encrypt(JSON.stringify(value))));
    }
  }

  view(): SearchView {
    const s = this.get();
    return s ? { service: s.service, hasKey: true } : { service: "free", hasKey: false };
  }
}

const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/** One search through Tavily or Brave with the user's key; their results as the free search gives them. */
export async function keyedSearch(
  s: { service: Exclude<SearchService, "free">; key: string },
  query: string,
  urls: SearchUrls,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const timeout = AbortSignal.timeout(20_000);
  const res =
    s.service === "tavily"
      ? await fetch(urls.tavily, {
          method: "POST",
          headers: { Authorization: `Bearer ${s.key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query, max_results: MAX_RESULTS, search_depth: "basic" }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
      : await fetch(`${urls.brave}?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`, {
          headers: { "X-Subscription-Token": s.key, Accept: "application/json" },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
  const name = s.service === "tavily" ? "Tavily" : "Brave Search";
  if (res.status === 401 || res.status === 403) throw new SearchFailure("auth", `${name} did not accept the key.`);
  // Tavily answers 432 when the plan's searches are used up; both answer 429 for too many at once.
  if (res.status === 429 || res.status === 432) throw new SearchFailure("limit", `${name}: the searches of the plan are used up or too frequent. Wait, or go on with what you know.`);
  if (!res.ok) throw new SearchFailure("failed", `${name} answered ${res.status}.`);
  const body = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  const rows =
    s.service === "tavily"
      ? (body.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: plain(r.content ?? "") }))
      : (body.web?.results ?? []).map((r) => ({ title: plain(r.title ?? ""), url: r.url ?? "", snippet: plain(r.description ?? "") }));
  const results = rows.filter((r) => r.url).slice(0, MAX_RESULTS);
  if (results.length === 0) throw new SearchFailure("failed", "The search returned no results; try other words.");
  return results;
}

/** The internet for models: the service with the key when one is set, the free search otherwise. */
export function withSearchService(base: WebAccess, store: SearchStore, urls: SearchUrls): WebAccess {
  return {
    ...base,
    search: (query, signal) => {
      const s = store.get();
      return s ? keyedSearch(s, query, urls, signal) : base.search(query, signal);
    },
  };
}

/** One search with the set key, to tell whether it works. */
export async function checkSearch(store: SearchStore, urls: SearchUrls, query = "test"): Promise<SearchCheck> {
  const s = store.get();
  if (!s) return { ok: false, error: { code: "failed", detail: "No search service is set." } };
  const started = Date.now();
  try {
    const results = await keyedSearch(s, query, urls);
    return { ok: true, ms: Date.now() - started, results };
  } catch (err) {
    const code = err instanceof SearchFailure ? err.code : "failed";
    return { ok: false, error: { code, detail: (err instanceof Error ? err.message : String(err)).split(s.key).join("•••") } };
  }
}
