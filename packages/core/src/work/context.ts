import type { ModelMessage } from "ai";
import { cutPoint, sizeOf, type Remembered } from "../agent/memory";
import { pruneOutputs } from "../agent/prune";

/**
 * How a project's conversation stays within the model's window (asked for: "the best of both", OpenCode and DeepSeek
 * Harness). The whole conversation goes to the model until it nears the limit: nothing read is cut away early, so the
 * agent does not read the same files again, and the start of every request stays the same for the provider's cache.
 * Near the limit, first the old tools' outputs are cut, which needs no model; when that is not enough, the older part
 * becomes one summary the model writes, and the newest part stays whole.
 */

/** After cutting outputs, the conversation should be at most this share of the limit, or a summary is written too. */
export const RELIEF = 0.7;
/** The share of the limit the newest messages keep whole beside a summary (DeepSeek Harness keeps 16 %). */
export const KEEP_TAIL = 0.16;

export interface Fitted {
  pruned: boolean;
  summarized: boolean;
  costUsd: number;
}

/**
 * Shortens `messages` in place when they pass `limit` (characters, memory.ts), or whenever `force` is set (the provider
 * said the request was too long). `summarize` writes the summary of the messages before the cut.
 */
export async function fitContext(
  messages: ModelMessage[],
  limit: number,
  summarize: (upTo: number) => Promise<Remembered>,
  o: { force?: boolean; thinking?: boolean } = {},
): Promise<Fitted> {
  const done: Fitted = { pruned: false, summarized: false, costUsd: 0 };
  if (!o.force && sizeOf(messages) <= limit) return done;
  const before = sizeOf(messages);
  const cut = pruneOutputs(messages, undefined, undefined, o.thinking).messages;
  if (sizeOf(cut) < before) {
    messages.splice(0, messages.length, ...cut);
    done.pruned = true;
  }
  if (!o.force && sizeOf(messages) <= limit * RELIEF) return done;
  const upTo = cutPoint(messages, null, limit, undefined, KEEP_TAIL);
  if (upTo === null) return done;
  const r = await summarize(upTo);
  // The task stays first, then the summary, then the newest messages as they were.
  messages.splice(1, upTo - 1, { role: "user", content: r.memory.summary });
  done.summarized = true;
  done.costUsd = r.costUsd;
  return done;
}
