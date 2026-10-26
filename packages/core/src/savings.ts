import type { ModelSpending } from "@drimvox/shared";
import type { Database } from "./db";
import type { ProviderRepo } from "./providers/repo";

/**
 * Where the money went, by model: the answers of chats and of projects' runs, and what agents' tasks spent (the
 * interview, the plan, the checks), which are kept apart (seen: the list showed only the chats, a third of the money
 * was missing). Only spending: what another model would have cost is not guessed at here (asked for).
 */
export function spendingByModel(db: Database, providers: ProviderRepo, since: number): ModelSpending[] {
  const rows = db.sql
    .prepare(
      `select provider_id as providerId, model, count(*) as answers, coalesce(sum(i), 0) as input, coalesce(sum(o), 0) as output, coalesce(sum(c), 0) as cost
       from (
         select provider_id, model, input_tokens as i, output_tokens as o, cost_usd as c
         from messages where role = 'assistant' and created_at >= ? and model is not null
         union all
         select t.provider_id, t.model, u.input_tokens, u.output_tokens, u.cost_usd
         from agent_usage u left join tasks t on t.id = u.task_id where u.created_at >= ?
       )
       group by provider_id, model having cost > 0 order by cost desc limit 30`,
    )
    .all(since, since) as { providerId: string | null; model: string | null; answers: number; input: number; output: number; cost: number }[];
  return rows.map((r) => ({
    providerId: r.providerId ?? "",
    // A provider deleted since, or a task gone with its project: the money still counts.
    providerName: (r.providerId && providers.get(r.providerId)?.name) || "—",
    model: r.model ?? "—",
    answers: r.answers,
    inputTokens: r.input,
    outputTokens: r.output,
    costUsd: r.cost,
  }));
}
