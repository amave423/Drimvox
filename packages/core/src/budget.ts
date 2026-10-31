import { presets, type MonthUsage } from "@drimvox/shared";
import type { ChatRepo } from "./chats/repo";
import type { Connection } from "./providers/repo";
import type { Database } from "./db";
import { readSettings } from "./settings";

/** The first moment of this month, on this computer's clock. */
export function monthStart(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/**
 * The month's spending against the budget for the whole app (asked for: a warning and a stop). Chats, pictures, clips
 * and agents all count; models without a price do not.
 */
export function monthUsage(db: Database, chats: ChatRepo): MonthUsage {
  const budgetUsd = readSettings(db).monthlyBudgetUsd;
  const spentUsd = chats.usageSince(monthStart()).costUsd;
  return { spentUsd, budgetUsd, over: budgetUsd !== null && spentUsd >= budgetUsd, since: monthStart() };
}

/**
 * A model on this computer (Ollama, LM Studio): slow on most machines, so it is never cut off for keeping quiet or for
 * the hours of a project's run (asked for: local models had limits on top of being slow). Only Stop ends it.
 */
export function isLocal(conn: Pick<Connection, "preset">): boolean {
  return conn.preset === "ollama" || conn.preset === "lmstudio";
}

/** The longest a timer may wait (setTimeout's own limit, about 24 days): "no limit" for a local model. */
export const NO_LIMIT_MS = 2_147_483_647;

/** Answers that cost nothing go on past the budget: models on this computer, subscriptions, credits, a flat fee. */
export function isFreeToRun(conn: Pick<Connection, "preset" | "flat">): boolean {
  return conn.flat || presets[conn.preset].billing !== "paid";
}
