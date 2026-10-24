import type { SubscriptionLimit } from "@drimvox/shared";
import type { CliId } from "./kinds";

/**
 * How much of the subscription's limit is used, as each CLI last reported it while it ran. Claude Code says it in
 * its stream ("rate_limit_event"); Codex in "rate_limits". Nothing asks the vendor on its own: Drimvox only knows after
 * a run, and forgets on restart.
 */
const seen = new Map<CliId, Map<string, SubscriptionLimit>>();

export function rememberLimit(id: CliId, limit: SubscriptionLimit): void {
  const own = seen.get(id) ?? new Map<string, SubscriptionLimit>();
  own.set(limit.window, limit);
  seen.set(id, own);
}

/** The latest of each window; the shorter windows first. */
export function limitsOf(id: CliId): SubscriptionLimit[] {
  const order = (w: string) => (w === "five_hour" ? 0 : w === "seven_day" ? 2 : 1);
  return [...(seen.get(id)?.values() ?? [])].sort((a, b) => order(a.window) - order(b.window));
}

export function forgetLimits(): void {
  seen.clear();
}

/** Codex's window comes in minutes. */
export function windowName(minutes: number | undefined): string {
  if (minutes === 300) return "five_hour";
  if (minutes === 10_080) return "seven_day";
  return minutes ? `${minutes}m` : "other";
}
