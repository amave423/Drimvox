import type { AcceptanceReport, Requirement, VisualCheck } from "@artel/shared";
import { findModel } from "../providers/catalog";
import { runVisualChecks, visualTools, type VisualDeps } from "../visual/tools";
import { accepted, MAX_ACCEPTANCE_ROUNDS, reworkMessage, runAcceptance } from "./acceptance";
import { discardChanges } from "./git";
import type { PassContext } from "./pass";
import type { TaskRow } from "./repo";
import { hasChanges, snapshot } from "./review";

/** Visual checks this many times in a row fail before the task waits for the user. */
export const MAX_VISUAL_ATTEMPTS = 2;

/**
 * Green checks: Artel looks at the pages from the spec, then the acceptance agent checks every requirement,
 * then the work goes to review. Returns the message for the coder when something has to be redone.
 */
export async function done(
  ctx: PassContext,
  id: string,
  row: TaskRow,
  visual: VisualDeps,
  summary: string | null,
  commitMessage: string | null,
): Promise<string | null> {
  const pages = JSON.parse(row.visual) as VisualCheck[];
  if (pages.length > 0 && (!visual.vision || !visual.kit.screenshot)) {
    ctx.event("text", {
      text: "Artel skipped the visual checks: there is no model that sees pictures (pick one in the settings) or no way to take screenshots here.",
    });
  } else if (pages.length > 0) {
    const results = await runVisualChecks(visual, pages, ctx.signal);
    if (ctx.signal.aborted) return stop(ctx, "stopped", "user");
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      const attempts = row.visual_attempts + 1;
      ctx.tasks.update(id, { visual_attempts: attempts });
      const report = failed.map((f) => `${f.check.url}\nExpected: ${f.check.expect}\nSeen: ${f.answer}`).join("\n\n");
      if (attempts >= MAX_VISUAL_ATTEMPTS) return stop(ctx, "waiting", "visual_failed", report.slice(0, 4000));
      return `Artel looked at the page and it does not match the spec yet:\n\n${report}\n\nFix it, run the checks, then call finish.`;
    }
  }

  const requirements = JSON.parse(row.requirements) as Requirement[];
  let reason: string | null = null;
  if (requirements.length > 0) {
    const verdict = await acceptWork(ctx, id, row, visual, requirements);
    if (verdict === null) return null;
    if (typeof verdict === "string") return verdict;
    if (!accepted(verdict)) reason = "acceptance_partial";
  }
  await complete(ctx, id, summary, commitMessage, reason);
  return null;
}

/**
 * One acceptance round. Returns the report when the work goes to the user, the rework message when the coder
 * has another round, or null when the task stopped or waits.
 */
async function acceptWork(
  ctx: PassContext,
  id: string,
  row: TaskRow,
  visual: VisualDeps,
  requirements: Requirement[],
): Promise<AcceptanceReport | string | null> {
  const ref = ctx.acceptanceModel();
  const own = row.provider_id ? ctx.providers.connection(row.provider_id) : null;
  const chosen = ref ? ctx.providers.connection(ref.providerId) : null;
  const conn = chosen ?? own!;
  const model = chosen ? ref!.model : row.model;
  const round = row.acceptance_rounds + 1;

  // The coder's work is saved first: whatever the acceptance agent leaves behind is thrown away afterwards.
  await snapshot(row);
  ctx.event("phase", { phase: "acceptance", round });
  let cost = row.cost_usd;
  const outcome = await runAcceptance({
    conn,
    model,
    price: await findModel(conn, model),
    worktree: row.worktree,
    task: row.task,
    spec: row.spec,
    requirements,
    decisions: JSON.parse(row.decisions) as string[],
    round,
    ownTools: visualTools(visual),
    spentUsd: row.cost_usd,
    budgetUsd: row.budget_usd,
    signal: ctx.signal,
    idleTimeoutMs: ctx.idleTimeoutMs,
    hooks: visual.hooks,
    onStep: (step) => {
      if (ctx.closed()) return;
      const current = ctx.tasks.row(id)!;
      cost = current.cost_usd + step.costUsd;
      ctx.tasks.update(id, {
        cost_usd: cost,
        input_tokens: current.input_tokens + step.inputTokens,
        output_tokens: current.output_tokens + step.outputTokens,
        steps: current.steps + 1,
      });
      ctx.tasks.addUsage(id, step.inputTokens, step.outputTokens, step.costUsd, step.priced);
      ctx.publish();
    },
  });
  visual.kit.background.stopAll(id);
  await discardChanges(row.worktree);

  if (outcome.kind === "stopped") return stop(ctx, "stopped", "user");
  if (outcome.kind === "budget") return stop(ctx, "waiting", "budget");
  if (outcome.kind === "error") return stop(ctx, "failed", outcome.error.code, outcome.error.detail);

  const report = outcome.report;
  ctx.tasks.update(id, { acceptance: JSON.stringify(report), acceptance_rounds: round });
  ctx.event("acceptance", report);
  if (accepted(report) || round >= MAX_ACCEPTANCE_ROUNDS) return report;
  ctx.tasks.update(id, { attempts: 0 });
  return reworkMessage(report, requirements);
}

/**
 * Acceptance of a goal once every subtask is merged and the goal's checks are green: the report when the goal
 * goes to the user, the rework for a fix subtask, or null when the goal stopped or waits.
 */
export async function acceptGoal(ctx: PassContext, id: string): Promise<AcceptanceReport | string | null> {
  const row = ctx.tasks.row(id)!;
  const hooks = {
    onCall: (call: { callId: string; name: string; input: unknown }) => ctx.event("tool_call", call),
    onResult: (result: { callId: string; name: string; ok: boolean; output: string }) => ctx.event("tool_result", result),
    askApproval: ctx.askApproval,
  };
  const visual: VisualDeps = {
    kit: ctx.visualKit,
    taskId: id,
    worktree: row.worktree,
    vision: await ctx.vision(row),
    hooks,
    onSpend: () => {},
    event: (kind, data) => ctx.event(kind, data),
  };
  ctx.setStatus("running", null);
  return acceptWork(ctx, id, row, visual, JSON.parse(row.requirements) as Requirement[]);
}

export function lastSummary(ctx: PassContext, id: string): string | null {
  const finishCall = ctx.tasks
    .events(id)
    .filter((e) => e.kind === "tool_call" && e.data?.name === "finish")
    .at(-1);
  return (finishCall?.data?.input?.summary as string | undefined) ?? null;
}

async function complete(ctx: PassContext, id: string, summary: string | null, commitMessage: string | null, reason: string | null): Promise<void> {
  const current = ctx.tasks.row(id)!;
  await snapshot(current);
  const project = ctx.projects.get(current.project_id)!;
  const changed = await hasChanges(project.path, current);
  const finishInput = ctx.tasks
    .events(id)
    .filter((e) => e.kind === "tool_call" && e.data?.name === "finish")
    .at(-1)?.data?.input as { commit_message?: string } | undefined;
  ctx.tasks.update(id, {
    summary: summary ?? current.summary ?? "—",
    commit_message: commitMessage ?? finishInput?.commit_message?.split("\n")[0]?.trim() ?? current.commit_message ?? current.title,
  });
  ctx.finish(changed ? "review" : "done_empty", changed ? reason : null);
}

function stop(ctx: PassContext, status: TaskRow["status"], reason: string, detail?: string): null {
  ctx.finish(status, reason, detail);
  return null;
}
