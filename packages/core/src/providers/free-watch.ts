import type { FreeCheck, ModelInfo, ModelRef } from "@drimvox/shared";
import type { Database } from "../db";
import { isCli } from "../cli/kinds";
import { availabilityOf, canCheck, noteAvailability, probe } from "./availability";
import { listModels } from "./catalog";
import type { ProviderRepo } from "./repo";

const KEY = "free.models";
/** A provider's list is waited for this long; a slow one keeps what was known (seen: one slow provider held every list for 40 s). */
const LIST_MS = 8_000;
/** How often the free models are asked a word in the background. */
const EVERY_MS = 30 * 60_000;
/** Models of one provider asked at once; every provider goes at the same time (one slow provider held the rest). */
const AT_ONCE = 3;
/** The first check after the start: soon, so the free models are known when a chat is opened (asked for). */
const FIRST_MS = 5_000;

export interface FreeModel {
  providerId: string;
  model: string;
  name: string;
  providerName: string;
  tools: boolean | null;
  /** The provider is paid by a flat fee, not by tokens: all its models are free to Drimvox. */
  flat: boolean;
  /** Its context window, as the provider lists it; absent in lists kept before it was. */
  contextLength?: number | null;
}

const keyOf = (m: ModelRef) => `${m.providerId}|${m.model}`;
const isFree = (m: ModelInfo) => m.freeTier === true || (m.priceIn === 0 && m.priceOut === 0);
const within = <T>(work: Promise<T>, ms: number) => Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), ms).unref())]);

/**
 * Free models and those of flat-fee providers (docs/specs/model-chains.md), kept between starts so the chains open at once;
 * each provider's list is refreshed in the background, a slow one does not hold the others. In the background, too, each
 * is asked one word every half hour (paid models never are): whether it answers, how fast, or that it is busy or gone.
 */
export class FreeWatch {
  private readonly checks = new Map<string, FreeCheck>();
  private refreshing: Promise<void> | null = null;
  private checking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Stopped with the core: a refresh still under way does not write into a closed database. */
  private closed = false;

  constructor(
    private readonly db: Database,
    private readonly providers: ProviderRepo,
  ) {}

  /** What is known now, without waiting for any provider; a refresh starts behind it when none runs. */
  list(): FreeModel[] {
    if (!this.closed) void this.refresh().catch(() => {});
    const row = this.db.sql.prepare("select value from settings where key = ?").get(KEY) as { value: string } | undefined;
    const kept = row ? (JSON.parse(row.value) as FreeModel[]) : [];
    const live = new Set(this.providers.list().map((p) => p.id));
    return kept.filter((m) => live.has(m.providerId));
  }

  check(ref: ModelRef): FreeCheck {
    const own = this.checks.get(keyOf(ref));
    if (own) return own;
    // What a chat or an earlier start learned of it (kept between starts).
    const conn = this.providers.connection(ref.providerId);
    const known = conn ? availabilityOf(conn, ref.model) : undefined;
    return known ? { state: known, ms: null, at: null } : { state: "unknown", ms: null, at: null };
  }

  /** What a chain's own call found: it answers (and how fast), or it is busy. */
  note(ref: ModelRef, ok: boolean, ms: number): void {
    this.checks.set(keyOf(ref), ok ? { state: "ok", ms, at: Date.now() } : { state: "busy", ms: null, at: Date.now() });
  }

  /** The lists of every provider again, each waited for a few seconds at most. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const row = this.db.sql.prepare("select value from settings where key = ?").get(KEY) as { value: string } | undefined;
      const kept = row ? (JSON.parse(row.value) as FreeModel[]) : [];
      const next: FreeModel[] = [];
      await Promise.all(
        this.providers.list().map(async (p) => {
          const conn = this.providers.connection(p.id);
          if (!conn || isCli(conn.preset) || conn.preset === "sdcpp" || conn.preset === "whispercpp") return;
          const models = await within(
            listModels(conn).catch(() => null),
            LIST_MS,
          );
          if (!models) {
            next.push(...kept.filter((m) => m.providerId === p.id));
            return;
          }
          for (const m of models) if (isFree(m) && m.available !== "gone") next.push({ providerId: p.id, model: m.id, name: m.name, providerName: p.name, tools: m.tools, flat: conn.flat, contextLength: m.contextLength });
        }),
      );
      if (this.closed) return;
      this.db.sql.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(KEY, JSON.stringify(next));
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** Asks each free model one word, a few at a time; a model being asked shows "checking". */
  checkAll(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      await this.refresh();
      const queue = this.list().filter((m) => {
        const conn = this.providers.connection(m.providerId);
        return conn && (conn.flat || canCheck(conn));
      });
      for (const m of queue) this.checks.set(keyOf(m), { ...this.check(m), state: "checking" });
      const byProvider = new Map<string, FreeModel[]>();
      for (const m of queue) byProvider.set(m.providerId, [...(byProvider.get(m.providerId) ?? []), m]);
      const worker = async (mine: FreeModel[]) => {
        for (let m = mine.shift(); m; m = mine.shift()) {
          const conn = this.providers.connection(m.providerId);
          if (!conn) continue;
          const started = Date.now();
          const state = await probe(conn, m.model, 1);
          const ms = Date.now() - started;
          if (state) noteAvailability(conn, m.model, state);
          this.checks.set(keyOf(m), { state: state ?? "unknown", ms: state === "ok" ? ms : null, at: Date.now() });
        }
      };
      await Promise.all([...byProvider.values()].flatMap((mine) => Array.from({ length: AT_ONCE }, () => worker(mine))));
    })().finally(() => (this.checking = null));
    return this.checking;
  }

  /** A check soon when some free model has never been asked (not more often than every ten minutes). */
  kick(): void {
    if (this.closed || this.checking || Date.now() - this.kicked < 10 * 60_000) return;
    if (!this.list().some((m) => this.check(m).state === "unknown")) return;
    this.kicked = Date.now();
    void this.checkAll().catch(() => {});
  }
  private kicked = 0;

  /** Every half hour in the background, the first a few seconds after the start. */
  start(firstMs = FIRST_MS): void {
    if (this.timer) return;
    const first = setTimeout(() => void this.checkAll().catch(() => {}), firstMs);
    first.unref();
    this.timer = setInterval(() => void this.checkAll().catch(() => {}), EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
