import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { autoChainIds, modelChainsSchema, type ChainView, type ModelChain, type ModelInfo, type ModelRef } from "@drimvox/shared";
import { APICallError } from "ai";
import type { Database } from "../db";
import { isCli } from "../cli/kinds";
import { listModels } from "./catalog";
import { languageModel } from "./model";
import type { Connection, ProviderRepo } from "./repo";

const KEY = "chains";
/** How long a model that failed rests when it does not say until when. */
const REST_MS = 15 * 60_000;
/** A limit's own reset, when the provider names it, is trusted up to this long. */
const MAX_REST_MS = 24 * 60 * 60_000;

const AUTO: Record<(typeof autoChainIds)[number], { name: string; toolsOnly: boolean }> = {
  "auto-code": { name: "Авто: для кода", toolsOnly: true },
  "auto-chat": { name: "Авто: для чата", toolsOnly: false },
};

const keyOf = (m: ModelRef) => `${m.providerId}|${m.model}`;
const isFree = (m: ModelInfo) => m.freeTier === true || (m.priceIn === 0 && m.priceOut === 0);

/** A call that went wrong in a way the next model may not: a limit, a server error, silence. */
class Pass extends Error {
  constructor(
    readonly why: "limit" | "error" | "silence",
    readonly restUntil: number,
    readonly cause: unknown,
  ) {
    super(why);
  }
}

/**
 * Chains of free models (docs/specs/model-chains.md): the user's own, kept in the settings, and two Drimvox makes from
 * every free model it knows. A chain answers as one model: the first that can, in turn; one that hit its limit or failed
 * rests until its limit resets (or a while), and the next takes the question.
 */
export class Chains {
  private readonly resting = new Map<string, number>();
  /** How models answered here: successes, failures and the last time to the first word, for "best first". */
  private readonly record = new Map<string, { ok: number; failed: number; ms: number }>();
  private readonly answered = new Map<string, string>();

  constructor(
    private readonly db: Database,
    private readonly providers: ProviderRepo,
  ) {}

  /** The user's chains. */
  own(): ModelChain[] {
    const row = this.db.sql.prepare("select value from settings where key = ?").get(KEY) as { value: string } | undefined;
    if (!row) return [];
    const parsed = modelChainsSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : [];
  }

  save(chains: ModelChain[]): void {
    this.db.sql.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(KEY, JSON.stringify(chains));
  }

  /** The free models a chain can be made of, for the settings' "Add a model". */
  async free(): Promise<{ providerId: string; model: string; name: string; providerName: string; tools: boolean | null }[]> {
    return (await this.freeModels()).map((f) => ({ ...f.ref, name: f.info.name, providerName: f.providerName, tools: f.info.tools }));
  }

  /** Every free model of every provider, with what the catalog knows of it. */
  private async freeModels(): Promise<{ ref: ModelRef; info: ModelInfo; providerName: string }[]> {
    const all = await Promise.all(
      this.providers.list().map(async (p) => {
        const conn = this.providers.connection(p.id);
        if (!conn || isCli(conn.preset) || conn.preset === "sdcpp" || conn.preset === "whispercpp") return [];
        const models = await listModels(conn).catch(() => [] as ModelInfo[]);
        return models.filter((m) => isFree(m) && m.available !== "gone").map((info) => ({ ref: { providerId: p.id, model: info.id }, info, providerName: p.name }));
      }),
    );
    return all.flat();
  }

  private async chain(id: string): Promise<ModelChain | null> {
    const auto = AUTO[id as keyof typeof AUTO];
    if (!auto) return this.own().find((c) => c.id === id) ?? null;
    const free = await this.freeModels();
    // Models that call tools first (they also talk), then the ones the catalog says nothing about; local ones last.
    const picked = free.filter((f) => (auto.toolsOnly ? f.info.tools === true : f.info.tools !== false || !auto.toolsOnly));
    const local = (f: (typeof free)[number]) => (this.providers.connection(f.ref.providerId)?.preset === "ollama" ? 1 : 0);
    picked.sort((a, b) => local(a) - local(b) || Number(b.info.tools === true) - Number(a.info.tools === true) || (b.info.contextLength ?? 0) - (a.info.contextLength ?? 0));
    return { id, name: auto.name, models: picked.slice(0, 20).map((f) => f.ref), order: "best", onLimit: true, onError: true, timeoutS: 30, toolsOnly: auto.toolsOnly };
  }

  /** Every chain with its models' names and state, for the settings and the model picker. */
  async views(): Promise<ChainView[]> {
    const free = await this.freeModels();
    const names = new Map(free.map((f) => [keyOf(f.ref), f]));
    const chains = [...(await Promise.all(autoChainIds.map((id) => this.chain(id)))).filter((c): c is ModelChain => !!c), ...this.own()];
    return chains.map((c) => ({
      ...c,
      auto: c.id in AUTO,
      members: c.models.map((m) => {
        const known = names.get(keyOf(m));
        const until = this.resting.get(keyOf(m)) ?? null;
        return {
          ...m,
          name: known?.info.name ?? m.model,
          providerName: known?.providerName ?? this.providers.get(m.providerId)?.name ?? "?",
          state: until && until > Date.now() ? ("resting" as const) : ("ok" as const),
          until: until && until > Date.now() ? until : null,
        };
      }),
      answered: this.answered.get(c.id) ?? null,
    }));
  }

  /** The chains as models of the "chain" provider: free, and calling tools when the chain is made of such models. */
  async models(): Promise<ModelInfo[]> {
    return (await this.views()).map((c) => ({ id: c.id, name: c.name, contextLength: null, priceIn: 0, priceOut: 0, priceEstimated: false, tools: c.toolsOnly ? true : null, vision: null }));
  }

  /** The order to try a chain's models in now: resting ones out (unless all rest), the best first when asked. */
  private async order(chain: ModelChain): Promise<{ ref: ModelRef; conn: Connection }[]> {
    const now = Date.now();
    const usable = chain.models.flatMap((ref) => {
      const conn = this.providers.connection(ref.providerId);
      return conn && !isCli(conn.preset) ? [{ ref, conn }] : [];
    });
    const awake = usable.filter((u) => (this.resting.get(keyOf(u.ref)) ?? 0) <= now);
    const list = awake.length ? awake : [...usable].sort((a, b) => (this.resting.get(keyOf(a.ref)) ?? 0) - (this.resting.get(keyOf(b.ref)) ?? 0));
    if (chain.order !== "best") return list;
    const score = (r: ModelRef) => {
      const s = this.record.get(keyOf(r));
      return s ? (s.ok + 1) / (s.ok + s.failed + 2) - s.ms / 600_000 : 0.5;
    };
    return [...list].sort((a, b) => score(b.ref) - score(a.ref));
  }

  private note(chainId: string, ref: ModelRef, ok: boolean, ms: number, restUntil = 0): void {
    const k = keyOf(ref);
    const r = this.record.get(k) ?? { ok: 0, failed: 0, ms };
    this.record.set(k, ok ? { ok: r.ok + 1, failed: r.failed, ms } : { ok: r.ok, failed: r.failed + 1, ms: r.ms });
    if (ok) {
      this.resting.delete(k);
      this.answered.set(chainId, `${this.providers.get(ref.providerId)?.name ?? ref.providerId} / ${ref.model}`);
    } else this.resting.set(k, restUntil || Date.now() + REST_MS);
  }

  /** The chain as one language model: each call goes to its models in turn until one answers. */
  model(chainId: string): LanguageModelV4 {
    const self = this;
    const attempt = async <T>(options: LanguageModelV4CallOptions, call: (m: LanguageModelV4, o: LanguageModelV4CallOptions) => Promise<T>): Promise<T> => {
      const chain = await self.chain(chainId);
      if (!chain) throw new APICallError({ message: "The chain is gone", url: "drimvox://chain", requestBodyValues: {}, statusCode: 404 });
      const order = await self.order(chain);
      if (!order.length) throw new APICallError({ message: "The chain has no models that can answer", url: "drimvox://chain", requestBodyValues: {}, statusCode: 404 });
      let last: unknown = null;
      for (const { ref, conn } of order) {
        if (options.abortSignal?.aborted) break;
        const started = Date.now();
        try {
          const result = await call(languageModel(conn, ref.model) as LanguageModelV4, options);
          self.note(chainId, ref, true, Date.now() - started);
          return result;
        } catch (err) {
          if (options.abortSignal?.aborted) throw err;
          const pass = err instanceof Pass ? err : classify(err, chain);
          if (!pass) throw err;
          self.note(chainId, ref, false, 0, pass.restUntil);
          last = pass.cause;
        }
      }
      throw last ?? new Error("Every model of the chain is busy");
    };
    return {
      specificationVersion: "v4",
      provider: "drimvox-chain",
      modelId: chainId,
      supportedUrls: {},
      doGenerate: (options) => attempt(options, (m, o) => Promise.resolve(m.doGenerate(o))),
      doStream: (options) =>
        attempt(options, async (m, o) => {
          const chain = await self.chain(chainId);
          // Silence before the first word counts as failing: the call is cut and the next model asked.
          const cut = new AbortController();
          const signal = o.abortSignal ? AbortSignal.any([o.abortSignal, cut.signal]) : cut.signal;
          const timer = chain?.timeoutS ? setTimeout(() => cut.abort(), chain.timeoutS * 1000) : null;
          try {
            const result = await m.doStream({ ...o, abortSignal: signal });
            const reader = result.stream.getReader();
            const head: LanguageModelV4StreamPart[] = [];
            for (;;) {
              const { done, value } = await reader.read().catch((err: unknown) => {
                if (cut.signal.aborted && !o.abortSignal?.aborted) throw new Pass("silence", Date.now() + REST_MS, err);
                throw err;
              });
              if (done) break;
              if (value.type === "error") throw classify(value.error, chain!) ?? value.error;
              head.push(value);
              // A word, a thought or a tool call: this model answers, the rest of its stream follows as it comes.
              if (["text-delta", "reasoning-delta", "tool-input-start", "tool-call", "file"].includes(value.type)) break;
            }
            if (timer) clearTimeout(timer);
            const stream = new ReadableStream<LanguageModelV4StreamPart>({
              start(controller) {
                for (const part of head) controller.enqueue(part);
              },
              async pull(controller) {
                const { done, value } = await reader.read();
                if (done) controller.close();
                else controller.enqueue(value);
              },
              cancel(reason) {
                return reader.cancel(reason);
              },
            });
            return { ...result, stream };
          } catch (err) {
            if (cut.signal.aborted && !o.abortSignal?.aborted) throw new Pass("silence", Date.now() + REST_MS, err);
            throw err;
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
    };
  }
}

/** Whether to go on to the next model, and how long this one rests: by the status and the provider's own reset. */
function classify(err: unknown, chain: ModelChain): Pass | null {
  const status = APICallError.isInstance(err) ? err.statusCode : undefined;
  const headers = APICallError.isInstance(err) ? (err.responseHeaders ?? {}) : {};
  if (status === 429 || status === 402) {
    if (!chain.onLimit) return null;
    return new Pass("limit", Date.now() + resetIn(headers), err);
  }
  if (status === undefined || status >= 500 || status === 404 || status === 408) {
    if (!chain.onError) return null;
    return new Pass("error", Date.now() + REST_MS, err);
  }
  return null;
}

/** When a limit resets, as the provider says it (Retry-After, x-ratelimit-reset…), within a day. */
function resetIn(headers: Record<string, string>): number {
  const get = (name: string) => headers[name] ?? headers[name.toLowerCase()];
  const after = Number(get("retry-after"));
  if (after > 0) return Math.min(after * 1000, MAX_REST_MS);
  for (const name of ["x-ratelimit-reset-requests", "x-ratelimit-reset", "x-ratelimit-reset-tokens"]) {
    const raw = get(name);
    if (!raw) continue;
    const n = Number(raw);
    if (n > 1e12) return Math.min(Math.max(n - Date.now(), 0), MAX_REST_MS);
    if (n > 1e9) return Math.min(Math.max(n * 1000 - Date.now(), 0), MAX_REST_MS);
    if (n > 0) return Math.min(n * 1000, MAX_REST_MS);
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/.exec(raw);
    if (m) return Math.min(((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000, MAX_REST_MS);
  }
  return REST_MS;
}
