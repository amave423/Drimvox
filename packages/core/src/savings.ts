import type { ModelInfo, ModelSpending } from "@drimvox/shared";
import type { Database } from "./db";
import { listModels } from "./providers/catalog";
import type { ProviderRepo } from "./providers/repo";

/** Cheaper only when it is clearly so: a few percent are not worth changing a model for. */
const CHEAPER_BY = 0.7;
const SUGGESTIONS = 2;

const maker = (id: string) => (id.includes("/") ? id.split("/")[0]! : null);
const priceOf = (m: Pick<ModelInfo, "priceIn" | "priceOut">, input: number, output: number) => ((m.priceIn ?? 0) * input + (m.priceOut ?? 0) * output) / 1_000_000;

/**
 * Where the money went, by model, and what the same answers would have cost on cheaper models of the same maker at the
 * same provider that can do as much (tools, pictures, a long enough context). Asked for: "cheaper with the same quality";
 * quality cannot be measured here, so only the same maker's models are offered, and the user decides.
 */
export async function spendingByModel(db: Database, providers: ProviderRepo, since: number): Promise<ModelSpending[]> {
  const rows = db.sql
    .prepare(
      `select provider_id as providerId, model, count(*) as answers, coalesce(sum(input_tokens), 0) as input, coalesce(sum(output_tokens), 0) as output,
              coalesce(sum(cost_usd), 0) as cost
       from messages where role = 'assistant' and created_at >= ? and provider_id is not null and model is not null
       group by provider_id, model having cost > 0 order by cost desc limit 20`,
    )
    .all(since) as { providerId: string; model: string; answers: number; input: number; output: number; cost: number }[];
  const out: ModelSpending[] = [];
  for (const r of rows) {
    const provider = providers.get(r.providerId);
    const conn = providers.connection(r.providerId);
    let cheaper: ModelSpending["cheaper"] = [];
    if (conn) {
      const models = await listModels(conn).catch(() => [] as ModelInfo[]);
      const used = models.find((m) => m.id === r.model);
      const family = maker(r.model);
      cheaper = models
        .filter((m) => m.id !== r.model && m.priceIn !== null && m.priceOut !== null && (m.priceIn > 0 || m.priceOut > 0))
        .filter((m) => family === null || maker(m.id) === family)
        .filter((m) => (used?.tools !== true || m.tools === true) && (used?.vision !== true || m.vision === true))
        .filter((m) => !used?.contextLength || !m.contextLength || m.contextLength >= Math.min(used.contextLength, 64_000))
        .map((m) => ({ model: m.id, name: m.name, priceIn: m.priceIn!, priceOut: m.priceOut!, wouldCostUsd: priceOf(m, r.input, r.output) }))
        .filter((m) => m.wouldCostUsd <= r.cost * CHEAPER_BY)
        // The dearest of the cheaper ones first: the closest to what was used.
        .sort((a, b) => b.wouldCostUsd - a.wouldCostUsd)
        .slice(0, SUGGESTIONS);
    }
    out.push({ providerId: r.providerId, providerName: provider?.name ?? r.providerId, model: r.model, answers: r.answers, inputTokens: r.input, outputTokens: r.output, costUsd: r.cost, cheaper });
  }
  return out;
}
