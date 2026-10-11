import { presets, type PresetId, type ProviderCreate, type ProviderUpdate, type ProviderView } from "@artel/shared";
import { randomUUID } from "node:crypto";
import type { Database } from "../db";
import type { Cipher } from "../secrets";

/** Everything needed to call a provider. Lives only inside the core. */
export interface Connection {
  id: string;
  preset: PresetId;
  baseUrl: string;
  apiKey: string | null;
  /** Changes whenever the address or key changes, so cached catalogs go stale. */
  cacheKey: string;
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
}

export class ProviderRepo {
  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher,
  ) {}

  list(): ProviderView[] {
    return this.rows("select * from providers order by created_at").map(toView);
  }

  get(id: string): ProviderView | null {
    const row = this.row(id);
    return row ? toView(row) : null;
  }

  create(input: ProviderCreate): ProviderView {
    const preset = presets[input.preset];
    if (input.baseUrl && !preset.editableUrl) throw new InvalidInput(`The address of ${preset.name} cannot be changed`);
    const baseUrl = input.baseUrl ?? preset.baseUrl;
    if (!baseUrl) throw new InvalidInput("An address is required");
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
    };
    this.db.sql
      .prepare("insert into providers values (:id, :preset, :name, :base_url, :secret, :created_at, :updated_at)")
      .run({ ...row });
    return toView(row);
  }

  update(id: string, patch: ProviderUpdate): ProviderView | null {
    const row = this.row(id);
    if (!row) return null;
    if (patch.baseUrl && !presets[row.preset].editableUrl) throw new InvalidInput("This address cannot be changed");
    const next: Row = {
      ...row,
      name: patch.name ?? row.name,
      base_url: patch.baseUrl ?? row.base_url,
      secret: patch.apiKey ? this.cipher.encrypt(patch.apiKey) : row.secret,
      updated_at: Date.now(),
    };
    this.db.sql
      .prepare("update providers set name = :name, base_url = :base_url, secret = :secret, updated_at = :updated_at where id = :id")
      .run({ id, name: next.name, base_url: next.base_url, secret: next.secret, updated_at: next.updated_at });
    return toView(next);
  }

  remove(id: string): boolean {
    return Number(this.db.sql.prepare("delete from providers where id = ?").run(id).changes) > 0;
  }

  /** Null when the provider does not exist. A key that cannot be decrypted counts as missing. */
  connection(id: string): Connection | null {
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
    return { id, preset: row.preset, baseUrl: row.base_url, apiKey, cacheKey: `${id}:${row.updated_at}` };
  }

  private row(id: string): Row | undefined {
    return this.db.sql.prepare("select * from providers where id = ?").get(id) as Row | undefined;
  }

  private rows(sql: string): Row[] {
    return this.db.sql.prepare(sql).all() as unknown as Row[];
  }
}

function toView(row: Row): ProviderView {
  return {
    id: row.id,
    preset: row.preset,
    name: row.name,
    baseUrl: row.base_url,
    hasKey: row.secret !== null,
    billing: presets[row.preset].billing,
    createdAt: row.created_at,
  };
}
