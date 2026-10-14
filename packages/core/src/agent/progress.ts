import type { PassContext } from "./pass";
import { failureReport, runChecks, type CheckResult } from "./checks";
import type { TaskRow } from "./repo";

/**
 * How far the checks are from green: every failing check weighs much, then the error lines it prints, so that fixing
 * half of forty type errors counts as progress.
 */
export function redness(results: CheckResult[]): number {
  return results.filter((r) => !r.ok).reduce((sum, r) => sum + 1_000 + (r.output.match(/\berror\b|\bfail(?:ed|ing)?\b|✗|×/gi)?.length ?? 0), 0);
}

/**
 * Hands a task that cannot get its checks green to the strong model from the settings, once. Null when there is none
 * to hand it to (none set, the same model, or it already took over).
 */
export function escalate(ctx: PassContext, id: string, row: TaskRow, why: string, report: string): string | null {
  const strong = ctx.strongModel();
  const strongConn = strong ? ctx.providers.connection(strong.providerId) : null;
  if (row.escalated || !strong || !strongConn || strong.model === row.model) return null;
  ctx.tasks.update(id, { provider_id: strong.providerId, model: strong.model, escalated: 1, attempts: 0, step_red: null });
  ctx.event("escalation", { from: row.model, to: strong.model });
  return `You are taking over this task from a weaker model that ${why}. The checks still fail:\n\n${report}\n\nFind the real cause, fix it, run the checks, then call finish.`;
}

/**
 * At the step limit Artel looks before it goes on (seen live: an agent patched a big file in circles for hundreds of
 * steps while its type errors grew). It runs the checks and tells the agent where they stand; when sixty more steps
 * brought them no closer, the strong model takes over, or the task waits for the user with the report.
 * Returns the message that goes on, or null when the task now waits.
 */
export async function pastStepLimit(ctx: PassContext, id: string, row: TaskRow, steps: number): Promise<string | null> {
  const going = `Artel continues on its own after ${steps} steps; the budget still limits the spending.`;
  const checks = JSON.parse(row.checks) as string[];
  if (row.phase !== "code" || checks.length === 0) {
    ctx.tasks.update(id, { step_rounds: row.step_rounds + 1 });
    ctx.event("text", { text: going });
    return "Continue the task.";
  }

  const results = await runChecks(checks, row.worktree, ctx.signal);
  for (const r of results) ctx.event("check", { phase: "code", ...r });
  if (ctx.signal.aborted) return null;
  if (results.every((r) => r.ok)) {
    ctx.tasks.update(id, { step_rounds: row.step_rounds + 1, step_red: 0 });
    ctx.event("text", { text: going });
    return "Continue the task. The checks pass now: once the work is done, call finish.";
  }

  const red = redness(results);
  const report = failureReport(results);
  if (row.step_red !== null && red >= row.step_red) {
    const handOver = escalate(ctx, id, row, `made no progress on the checks in ${steps} steps`, report);
    if (handOver) return handOver;
    ctx.finish("waiting", "stuck", `No closer to green checks after ${steps} more steps.\n\n${report}`.slice(0, 4000));
    return null;
  }
  ctx.tasks.update(id, { step_rounds: row.step_rounds + 1, step_red: red });
  ctx.event("text", { text: going });
  return `Continue the task. Where the checks stand now:\n\n${report}\n\nWork towards them passing; Artel looks again at the next ${steps} steps.`;
}
