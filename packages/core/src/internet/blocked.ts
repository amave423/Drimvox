import type { Database } from "../db";
import type { WebAccess } from "./web";

/** Kept next to the settings: the sites that open only through the proxy. */
const KEY = "proxy.sites";

/**
 * Sites known to be closed from Russia at the time of writing; the rest are found by themselves (a page that does not
 * open directly but opens through the proxy is added). The user edits the list in the settings.
 */
export const KNOWN_BLOCKED = ["instagram.com", "facebook.com", "x.com", "twitter.com", "linkedin.com", "discord.com", "rutracker.org", "medium.com"];

/** The host of an address, lower case, without "www."; null for what is not an address. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Asked for: the proxy only for sites closed from Russia, not for all — some Russian sites refuse visitors through a
 * proxy. A host matches its own entry and the entries of the domains above it (m.facebook.com → facebook.com).
 */
export class BlockedSites {
  private readonly listeners = new Set<(hosts: string[]) => void>();

  constructor(private readonly db: Database) {}

  list(): string[] {
    const row = this.db.sql.prepare("select value from settings where key = ?").get(KEY) as { value: string } | undefined;
    if (!row) return [...KNOWN_BLOCKED];
    try {
      const hosts = JSON.parse(row.value) as unknown;
      return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [...KNOWN_BLOCKED];
    } catch {
      return [...KNOWN_BLOCKED];
    }
  }

  set(hosts: string[]): string[] {
    const clean = [...new Set(hosts.map((h) => hostOf(h.includes("://") ? h : `https://${h.trim()}`)).filter((h): h is string => !!h && h.includes(".")))].sort();
    this.db.sql.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(KEY, JSON.stringify(clean));
    for (const l of this.listeners) l(clean);
    return clean;
  }

  add(host: string): void {
    if (!this.has(host)) this.set([...this.list(), host]);
  }

  has(host: string): boolean {
    const h = host.toLowerCase().replace(/^www\./, "");
    return this.list().some((site) => h === site || h.endsWith(`.${site}`));
  }

  /** Every change of the list (the desktop's browser follows it); returns the way to stop listening. */
  onChange(listener: (hosts: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

/** A failure of the connection itself (a reset, a timeout, no answer), not an answer of the site such as 404. */
export function connectionFailed(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  return err instanceof TypeError || /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|socket|fetch failed|other side closed/i.test(`${err.message} ${String((err as { cause?: unknown }).cause ?? "")}`);
}

/**
 * Page reading with the proxy for blocked sites only: a known one goes through the proxy at once; another that fails
 * to connect directly is tried through the proxy and, when that works, remembered.
 */
export function withBlockedProxy(base: WebAccess, o: { proxy(): string | null; sites: BlockedSites; openVia(url: string, proxy: string, signal?: AbortSignal): ReturnType<WebAccess["open"]> }): WebAccess {
  return {
    ...base,
    open: async (url, signal) => {
      const proxy = o.proxy();
      const host = hostOf(url);
      if (proxy && host && o.sites.has(host)) return o.openVia(url, proxy, signal);
      try {
        return await base.open(url, signal);
      } catch (err) {
        if (!proxy || !host || signal?.aborted || !connectionFailed(err)) throw err;
        const page = await o.openVia(url, proxy, signal);
        o.sites.add(host);
        return page;
      }
    },
  };
}
