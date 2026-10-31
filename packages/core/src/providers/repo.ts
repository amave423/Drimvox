import { CHAIN_PROVIDER_ID, presets, type ModelInfo, type PresetId, type ProviderCreate, type ProviderUpdate, type ProviderView } from "@drimvox/shared";
import { randomUUID } from "node:crypto";
import type { Database } from "../db";
import { fetchVia, noProxyFetch, type ProxyStore } from "../proxy";
import type { Cipher } from "../secrets";

/** Everything needed to call a provider. Lives only inside the core. */
export interface Connection {
  id: string;
  preset: PresetId;
  /** What the provider's prices and costs are in. */
  currency: "USD" | "RUB";
  baseUrl: string;
  apiKey: string | null;
  /** Changes whenever the address or key changes, so cached catalogs go stale. */
  cacheKey: string;
  /** The provider asked for the proxy; `proxy` is its address, null when none is set. */
  useProxy: boolean;
  proxy: string | null;
  /** Paid by a flat fee, not by tokens: its models cost nothing per answer. */
  flat: boolean;
  /** Every request to the provider goes through this: straight, or through the proxy. */
  fetch: typeof fetch;
  /** The chains of free models, when this is their provider (docs/specs/model-chains.md): models answer in turn. */
  chain?: ChainSource;
}

/** What the chains give the rest of the core: each chain as a model, and the list of them. */
export interface ChainSource {
  model(chainId: string): unknown;
  models(): Promise<ModelInfo[]>;
}

/** A request the API should answer with 400. */
export class InvalidInput extends Error {}

interface Row {
  id: string;
  preset: PresetId;
  name: string;
  base_url: string;
  secret: string | null;
  created_at: number;
  updated_at: number;
  use_proxy: number;
  flat: number;
}

/** A custom address that is really a known service gets that service's preset: prices, currency, media. */
const KNOWN_HOSTS: Partial<Record<string, PresetId>> = { "routerai.ru": "routerai", "openrouter.ai": "openrouter" };

/** The Ollama Drimvox looks after: its requests wake it up first. */
export interface LocalWaker {
  handles(baseUrl: string): boolean;
  ensureRunning(): Promise<boolean>;
  touch(): void;
}

export class ProviderRepo {
  private waker: LocalWaker | null = null;

  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher,
    private readonly proxies: ProxyStore,
    /** Tests point fixed presets at a fake server. */
    private readonly presetUrls: Partial<Record<PresetId, string>> = {},
  ) {}

  private chains: ChainSource | null = null;

  /** Set once the chains exist: their provider answers with them. */
  setChains(chains: ChainSource): void {
    this.chains = chains;
  }

  /** Set once the local models are set up: they need the providers too. */
  setWaker(waker: LocalWaker): void {
    this.waker = waker;
  }

  urlOf(preset: PresetId): string {
    return this.presetUrls[preset] ?? presets[preset].baseUrl;
  }

  list(): ProviderView[] {
    return this.rows("select * from providers where id <> 'chain' order by created_at").map(toView);
  }

  get(id: string): ProviderView | null {
    if (id === CHAIN_PROVIDER_ID && this.chains) return CHAIN_VIEW;
    const row = this.row(id);
    return row ? toView(row) : null;
  }

  create(given: ProviderCreate): ProviderView {
    const known = given.preset === "custom" && given.baseUrl ? KNOWN_HOSTS[hostOf(given.baseUrl)] : undefined;
    const input: ProviderCreate = known ? { ...given, preset: known, baseUrl: undefined } : given;
    const preset = presets[input.preset];
    if (input.baseUrl && !preset.editableUrl) throw new InvalidInput(`The address of ${preset.name} cannot be changed`);
    const baseUrl = input.baseUrl ?? this.urlOf(input.preset);
    // Command-line agents run on this computer and have no address.
    if (!baseUrl && !preset.cli) throw new InvalidInput("An address is required");
    if (preset.keyRequired && !input.apiKey) throw new InvalidInput("A key is required");

    const now = Date.now();
    const row: Row = {
      id: randomUUID(),
      preset: input.preset,
      name: input.name ?? (input.preset === "custom" ? new URL(baseUrl).host : preset.name),
      base_url: baseUrl,
      secret: input.apiKey ? this.cipher.encrypt(input.apiKey) : null,
      created_at: now,
      updated_at: now,
      use_proxy: 0,
      flat: 0,
    };
    this.db.sql
      .prepare(
        `insert into providers (id, preset, name, base_url, secret, created_at, updated_at, use_proxy, flat)
         values (:id, :preset, :name, :base_url, :secret, :created_at, :updated_at, :use_proxy, :flat)`,
      )
      .run({ ...row });
    return toView(row);
  }

  update(id: string, patch: ProviderUpdate): ProviderView | null {
    if (id === CHAIN_PROVIDER_ID) return null;
    const row = this.row(id);
    if (!row) return null;
    if (patch.baseUrl && !presets[row.preset].editableUrl) throw new InvalidInput("This address cannot be changed");
    const next: Row = {
      ...row,
      name: patch.name ?? row.name,
      base_url: patch.baseUrl ?? row.base_url,
      secret: patch.apiKey ? this.cipher.encrypt(patch.apiKey) : row.secret,
      use_proxy: patch.useProxy === undefined ? row.use_proxy : patch.useProxy ? 1 : 0,
      flat: patch.flat === undefined ? row.flat : patch.flat ? 1 : 0,
      updated_at: Date.now(),
    };
    this.db.sql
      .prepare(
        "update providers set name = :name, base_url = :base_url, secret = :secret, use_proxy = :use_proxy, flat = :flat, updated_at = :updated_at where id = :id",
      )
      .run({ id, name: next.name, base_url: next.base_url, secret: next.secret, use_proxy: next.use_proxy, flat: next.flat, updated_at: next.updated_at });
    return toView(next);
  }

  remove(id: string): boolean {
    if (id === CHAIN_PROVIDER_ID) return false;
    return Number(this.db.sql.prepare("delete from providers where id = ?").run(id).changes) > 0;
  }

  /** Null when the provider does not exist. A key that cannot be decrypted counts as missing. */
  connection(id: string): Connection | null {
    // The chains' provider: free (each model in a chain is), answering through the chain itself.
    if (id === CHAIN_PROVIDER_ID && this.chains) {
      return { id, preset: "custom", currency: "USD", baseUrl: "drimvox://chain", apiKey: null, cacheKey: "chain", useProxy: false, proxy: null, flat: true, fetch: globalThis.fetch, chain: this.chains };
    }
    const row = this.row(id);
    if (!row) return null;
    let apiKey: string | null = null;
    if (row.secret) {
      try {
        apiKey = this.cipher.decrypt(row.secret);
      } catch {
        apiKey = null;
      }
    }
    // Fixed presets always use their own address, so a test override or a moved endpoint applies at once.
    const baseUrl = presets[row.preset].editableUrl ? row.base_url : this.urlOf(row.preset);
    const useProxy = row.use_proxy === 1;
    const proxy = useProxy ? this.proxies.url() : null;
    return {
      id,
      preset: row.preset,
      currency: presets[row.preset].currency,
      baseUrl,
      apiKey,
      // A new proxy address makes cached catalogs stale too.
      cacheKey: `${id}:${row.updated_at}:${proxy ?? ""}`,
      useProxy,
      proxy,
      flat: row.flat === 1,
      fetch: this.wake(row.preset, baseUrl, !useProxy ? globalThis.fetch : proxy ? fetchVia(proxy) : noProxyFetch),
    };
  }

  /** Requests to the Ollama Drimvox started and stops: it is woken first, and each request keeps it a while longer. */
  private wake(preset: PresetId, baseUrl: string, inner: typeof fetch): typeof fetch {
    const waker = this.waker;
    if (preset !== "ollama" || !waker?.handles(baseUrl)) return inner;
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      await waker.ensureRunning();
      try {
        return await inner(input, init);
      } finally {
        waker.touch();
      }
    }) as typeof fetch;
  }

  private row(id: string): Row | undefined {
    return this.db.sql.prepare("select * from providers where id = ?").get(id) as Row | undefined;
  }

  private rows(sql: string): Row[] {
    return this.db.sql.prepare(sql).all() as unknown as Row[];
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The chains as a provider, for checks that a picked provider exists; it is never listed with the others. */
const CHAIN_VIEW: ProviderView = { id: CHAIN_PROVIDER_ID, preset: "custom", name: "Цепочки", baseUrl: "drimvox://chain", hasKey: false, billing: "free", currency: "USD", useProxy: false, flat: true, createdAt: 0 };

function toView(row: Row): ProviderView {
  return {
    id: row.id,
    preset: row.preset,
    name: row.name,
    baseUrl: row.base_url,
    hasKey: row.secret !== null,
    billing: presets[row.preset].billing,
    currency: presets[row.preset].currency,
    useProxy: row.use_proxy === 1,
    flat: row.flat === 1,
    createdAt: row.created_at,
  };
}
