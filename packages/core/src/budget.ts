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

/** Answers that cost nothing go on past the budget: models on this computer, subscriptions, credits, a flat fee. */
export function isFreeToRun(conn: Pick<Connection, "preset" | "flat">): boolean {
  return conn.flat || presets[conn.preset].billing !== "paid";
}
