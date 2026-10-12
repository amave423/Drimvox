import type { ProxyCheck, ProxyView } from "@artel/shared";
import { ProxyAgent, fetch as proxiedFetch } from "undici";
import type { Database } from "./db";
import { describeError, ProviderFailure } from "./providers/errors";
import type { Cipher } from "./secrets";

/** Kept next to the settings, encrypted: the address may hold a password. */
const KEY = "proxy";

/** The proxy for providers from the settings. One for all; each provider decides whether to use it. */
export class ProxyStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher,
  ) {}

  url(): string | null {
    const row = this.db.sql.prepare("select value from settings where key = ?").get(KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      return this.cipher.decrypt(JSON.parse(row.value) as string);
    } catch {
      return null;
    }
  }

  set(url: string | null): void {
    if (url === null) this.db.sql.prepare("delete from settings where key = ?").run(KEY);
    else {
      this.db.sql
        .prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
        .run(KEY, JSON.stringify(this.cipher.encrypt(url)));
    }
  }

  view(): ProxyView {
    const url = this.url();
    return { url: url ? masked(url) : null };
  }
}

/** The address as the interface may show it: the password replaced by dots. */
export function masked(url: string): string {
  const u = new URL(url);
  if (u.password) u.password = "•••";
  return u.toString().replace(/\/$/, "").replace("%E2%80%A2%E2%80%A2%E2%80%A2", "•••");
}

const agents = new Map<string, ProxyAgent>();

/** `fetch` that goes through the proxy; one connection pool per address. */
export function fetchVia(proxy: string): typeof fetch {
  let agent = agents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent(proxy);
    agents.set(proxy, agent);
  }
  const dispatcher = agent;
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    proxiedFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
}

/** For a provider that should go through a proxy when none is set: every request fails the same clear way. */
export const noProxyFetch = (async () => {
  throw new ProviderFailure({ code: "no_proxy" });
}) as unknown as typeof fetch;

/** One request through the proxy to a page that answers fast, to tell whether the proxy works. */
export async function checkProxy(proxy: string, target: string): Promise<ProxyCheck> {
  const started = Date.now();
  try {
    const res = await fetchVia(proxy)(target, { signal: AbortSignal.timeout(15_000) });
    await res.arrayBuffer().catch(() => undefined);
    if (res.status >= 400) return { ok: false, error: { code: "provider_error", detail: `HTTP ${res.status}` } };
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    const error = describeError(err);
    return { ok: false, error: { code: error.code, ...(error.detail ? { detail: error.detail.split(proxy).join(masked(proxy)) } : {}) } };
  }
}
