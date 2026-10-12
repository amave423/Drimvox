import type { Question, TaskEvent, TaskPhase, TaskStages } from "@artel/shared";
import type { ModelMessage, ToolSet } from "ai";
import { findModel } from "../providers/catalog";
import type { ProviderRepo } from "../providers/repo";
import { failureReport, runChecks, safeChecks } from "./checks";
import {
  answerTools,
  interviewTools,
  phaseInstructions,
  planInstructions,
  planTools,
  specMessage,
  specTools,
  type PlanProposal,
  type SpecProposal,
} from "./phases";
import type { ProjectRepo, TaskRepo, TaskRow } from "./repo";
import { hasChanges, snapshot } from "./review";
import { runAgent } from "./run";
import { webTools } from "../internet/tools";
import { findSkills, projectSkillRoots, skillsInstructions, skillTools } from "../skills/skills";
import type { WebAccess } from "../internet/web";
import type { ToolHooks } from "./tools";

const SPEC_REMINDER = "You must call propose_spec with the spec, the checks and the plan.";
const PLAN_REMINDER = "You must call propose_plan with the spec, the checks and the subtasks.";

/** Red check rounds in a row before a task escalates or stops. */
export const MAX_ATTEMPTS = 3;

/** What a pass needs from the runner: storage, notifications and the user's settings. */
export interface PassContext {
  tasks: TaskRepo;
  projects: ProjectRepo;
  providers: ProviderRepo;
  idleTimeoutMs: number;
  strongModel(): { providerId: string; model: string } | null;
  signal: AbortSignal;
  closed(): boolean;
  event(kind: TaskEvent["kind"], data: unknown): void;
  finish(status: TaskRow["status"], reason: string | null, detail?: string): void;
  setStatus(status: TaskRow["status"], reason: string | null): void;
  publish(): void;
  askApproval: ToolHooks["askApproval"];
  /** A goal's plan is settled: hand the subtasks to the team. */
  startTeam(): void;
  /** Search and page reading for every step: documentation, versions, current facts. */
  web: WebAccess;
  /** Shared skills of Artel; the project's own are found in the copy. */
  skillsDir: string;
  /** Tools of the user's MCP servers; the first call of each asks the user. */
  mcpTools(hooks: Omit<ToolHooks, "onFinish" | "askApproval">): Promise<ToolSet>;
  /** The picture tool when the settings name an image model; none otherwise. */
  imageTools(
    row: TaskRow,
    hooks: Omit<ToolHooks, "onFinish">,
    onSpend: (usd: number) => void,
    budgetLeft: () => number,
  ): Promise<ToolSet>;
}

/** The step after the spec, or after the interview when there is no spec step. */
export function stepAfterSpec(stages: TaskStages, checks: string[]): TaskPhase {
  return stages.testsFirst && checks.length > 0 ? "tests" : "code";
}

export function enterPhase(ctx: PassContext, id: string, phase: TaskPhase): void {
  ctx.tasks.update(id, { phase, attempts: 0 });
  ctx.event("phase", { phase });
}

/**
 * One model pass in the task's current step, then Artel's own decision about what comes next.
 * Returns the message that starts the next pass, or null when the task now waits or is done.
 */
export async function runPass(ctx: PassContext, id: string, userText: string): Promise<string | null> {
  const row = ctx.tasks.row(id)!;
  const phase = row.phase;
  const messages: ModelMessage[] = [...ctx.tasks.messages(id), { role: "user", content: userText }];
  ctx.tasks.update(id, { messages: JSON.stringify(messages) });
  ctx.event("user", { text: userText });
  ctx.setStatus("running", null);

  const conn = row.provider_id ? ctx.providers.connection(row.provider_id) : null;
  if (!conn) return finish(ctx, "failed", "no_provider");

  let questions: Question[] | null = null;
  let proposal: SpecProposal | null = null;
  let teamPlan: PlanProposal | null = null;
  let answered: string | null = null;
  const planning = row.kind === "goal" && phase === "spec";
  let extraTools: ToolSet | undefined;
  let stopTools: string[] | undefined;
  if (phase === "interview") {
    extraTools = interviewTools((q) => (questions = q));
    stopTools = ["ask_questions"];
  } else if (planning) {
    extraTools = planTools((p) => (teamPlan = p));
    stopTools = ["propose_plan"];
  } else if (phase === "spec") {
    extraTools = specTools((p) => (proposal = p));
    stopTools = ["propose_spec"];
  }
  if (phase === "interview" || phase === "spec") {
    extraTools = { ...extraTools, ...answerTools((a) => (answered = a)) };
    stopTools = [...(stopTools ?? []), "answer"];
  }

  let cost = row.cost_usd;
  let input = row.input_tokens;
  let output = row.output_tokens;
  let steps = row.steps;
  const hooks = {
    onCall: (call: { callId: string; name: string; input: unknown }) => ctx.event("tool_call", call),
    onResult: (result: { callId: string; name: string; ok: boolean; output: string }) => ctx.event("tool_result", result),
    askApproval: ctx.askApproval,
  };
  const mode = phase === "interview" || phase === "spec" ? "read" : "write";
  // The project's skills first: they win over shared ones of the same name.
  const skills = findSkills([...projectSkillRoots(row.worktree), { dir: ctx.skillsDir, scope: "shared" }]);
  let ownTools: ToolSet = { ...webTools(ctx.web, hooks), ...skillTools(skills, row.worktree, hooks), ...(await ctx.mcpTools(hooks)) };
  if (mode === "write") {
    // Pictures cost money outside the model's own usage: they go into the task's spending at once.
    const spend = (usd: number) => {
      cost += usd;
      ctx.tasks.update(id, { cost_usd: cost });
      ctx.tasks.addUsage(id, 0, 0, usd, true);
      ctx.publish();
    };
    ownTools = { ...ownTools, ...(await ctx.imageTools(row, hooks, spend, () => row.budget_usd - cost)) };
  }
  const outcome = await runAgent({
    conn,
    model: row.model,
    price: await findModel(conn, row.model),
    worktree: row.worktree,
    messages,
    mode,
    extraTools,
    ownTools,
    stopTools,
    instructions: [planning ? planInstructions() : phaseInstructions(phase, JSON.parse(row.checks) as string[]), skillsInstructions(skills)]
      .filter(Boolean)
      .join("\n\n"),
    spentUsd: row.cost_usd,
    budgetUsd: row.budget_usd,
    signal: ctx.signal,
    idleTimeoutMs: ctx.idleTimeoutMs,
    onText: (text) => ctx.event("text", { text }),
    onStep: (step) => {
      if (ctx.closed()) return;
      messages.push(...step.messages);
      cost += step.costUsd;
      input += step.inputTokens;
      output += step.outputTokens;
      steps++;
      ctx.tasks.update(id, { messages: JSON.stringify(messages), cost_usd: cost, input_tokens: input, output_tokens: output, steps });
      ctx.tasks.addUsage(id, step.inputTokens, step.outputTokens, step.costUsd, step.priced);
      ctx.publish();
    },
    hooks,
  });
  if (ctx.closed()) return null;

  if (outcome.kind === "stopped") return finish(ctx, "stopped", "user");
  if (outcome.kind === "error") return finish(ctx, "failed", outcome.error.code, outcome.error.detail);
  if (outcome.kind === "budget" || outcome.kind === "steps") return finish(ctx, "waiting", outcome.kind);

  // A question, not a task: the answer is the result and there is nothing to review.
  const answer = answered as string | null;
  if (answer !== null) {
    ctx.tasks.update(id, { summary: answer });
    ctx.event("answer", { text: answer });
    return finish(ctx, "done_empty", "answered");
  }

  const stages = JSON.parse(row.stages) as TaskStages;
  const asked = questions as Question[] | null;
  const proposed = proposal as SpecProposal | null;

  if (phase === "interview") {
    if (asked && asked.length > 0) {
      ctx.tasks.update(id, { questions: JSON.stringify(asked) });
      ctx.event("questions", { questions: asked });
      return finish(ctx, "waiting", "questions");
    }
    if (stages.spec) {
      enterPhase(ctx, id, "spec");
      return "Nothing to ask. Write the spec now and call propose_spec.";
    }
    enterPhase(ctx, id, "code");
    return "Nothing to ask. Implement the task now.";
  }

  if (planning) {
    const planned = teamPlan as PlanProposal | null;
    if (!planned) {
      if (messages.some((m) => m.role === "user" && m.content === PLAN_REMINDER)) return finish(ctx, "failed", "no_spec");
      return PLAN_REMINDER;
    }
    ctx.tasks.update(id, {
      spec: planned.spec,
      checks: JSON.stringify(planned.checks),
      plan: JSON.stringify(planned.plan),
      planned: JSON.stringify(planned.subtasks),
    });
    ctx.event("plan", { spec: planned.spec, checks: planned.checks, subtasks: planned.subtasks });
    if (stages.approveSpec) return finish(ctx, "waiting", "plan_review");
    const { kept } = safeChecks(planned.checks, row.worktree);
    ctx.tasks.update(id, { checks: JSON.stringify(kept) });
    ctx.startTeam();
    return null;
  }

  if (phase === "spec") {
    if (!proposed) {
      // One reminder; a model that still writes no spec will not start writing one.
      if (messages.some((m) => m.role === "user" && m.content === SPEC_REMINDER)) return finish(ctx, "failed", "no_spec");
      return SPEC_REMINDER;
    }
    ctx.tasks.update(id, { spec: proposed.spec, checks: JSON.stringify(proposed.checks), plan: JSON.stringify(proposed.plan) });
    ctx.event("spec", proposed);
    if (stages.approveSpec) return finish(ctx, "waiting", "spec_review");
    const { kept, dropped } = safeChecks(proposed.checks, row.worktree);
    ctx.tasks.update(id, { checks: JSON.stringify(kept) });
    if (dropped.length) ctx.event("text", { text: `Artel removed checks that would need permission: ${dropped.join(", ")}` });
    return startWork(ctx, id, stages, specMessage(proposed.spec, kept, false), kept);
  }

  const checks = JSON.parse(row.checks) as string[];
  if (phase === "tests") return testsGate(ctx, id, row, checks);
  if (phase === "code" && checks.length > 0) return codeGate(ctx, id, row, checks);
  await complete(ctx, id, outcome.summary, outcome.commitMessage);
  return null;
}

/** Moves from an approved spec to the tests or the code, with the message that starts it. */
export function startWork(ctx: PassContext, id: string, stages: TaskStages, specText: string, checks: string[]): string {
  const next = stepAfterSpec(stages, checks);
  enterPhase(ctx, id, next);
  return next === "tests"
    ? `${specText}\n\nStart with the tests: they must fail until the feature exists.`
    : `${specText}\n\nImplement the spec now.`;
}

async function check(ctx: PassContext, phase: TaskPhase, commands: string[], worktree: string) {
  const results = await runChecks(commands, worktree, ctx.signal);
  for (const r of results) ctx.event("check", { phase, ...r });
  return results;
}

/** After the tests step the checks must be red: otherwise the tests do not cover the new behaviour. */
async function testsGate(ctx: PassContext, id: string, row: TaskRow, checks: string[]): Promise<string | null> {
  const results = await check(ctx, "tests", checks, row.worktree);
  if (ctx.signal.aborted) return finish(ctx, "stopped", "user");
  if (results.some((r) => !r.ok)) {
    enterPhase(ctx, id, "code");
    return `The checks fail as expected:\n\n${failureReport(results)}\n\nNow implement the spec until every check passes, then call finish.`;
  }
  if (!row.tests_nudged) {
    ctx.tasks.update(id, { tests_nudged: 1 });
    return "All checks already pass, so the tests do not cover the new behaviour yet. Write tests that fail now, then call finish.";
  }
  ctx.event("text", { text: "The new tests passed before the code was written." });
  enterPhase(ctx, id, "code");
  return "Implement the spec now.";
}

/** Work counts as done only when Artel's own run of the checks is green. */
async function codeGate(ctx: PassContext, id: string, row: TaskRow, checks: string[]): Promise<string | null> {
  const results = await check(ctx, "code", checks, row.worktree);
  if (ctx.signal.aborted) return finish(ctx, "stopped", "user");
  if (results.every((r) => r.ok)) {
    await complete(ctx, id, lastSummary(ctx, id), null);
    return null;
  }
  const report = failureReport(results);
  const attempts = row.attempts + 1;
  if (attempts < MAX_ATTEMPTS) {
    ctx.tasks.update(id, { attempts });
    return `Artel ran the checks and they fail:\n\n${report}\n\nFix the cause (not the tests), run the checks, then call finish.`;
  }

  const strong = ctx.strongModel();
  const strongConn = strong ? ctx.providers.connection(strong.providerId) : null;
  if (!row.escalated && strong && strongConn && strong.model !== row.model) {
    ctx.tasks.update(id, { provider_id: strong.providerId, model: strong.model, escalated: 1, attempts: 0 });
    ctx.event("escalation", { from: row.model, to: strong.model });
    return `You are taking over this task from a weaker model that failed ${MAX_ATTEMPTS} times. The checks still fail:\n\n${report}\n\nFind the real cause, fix it, run the checks, then call finish.`;
  }
  ctx.tasks.update(id, { attempts });
  return finish(ctx, "waiting", "stuck", report.slice(0, 4000));
}

function lastSummary(ctx: PassContext, id: string): string | null {
  const finishCall = ctx.tasks
    .events(id)
    .filter((e) => e.kind === "tool_call" && e.data?.name === "finish")
    .at(-1);
  return (finishCall?.data?.input?.summary as string | undefined) ?? null;
}

async function complete(ctx: PassContext, id: string, summary: string | null, commitMessage: string | null): Promise<void> {
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
  ctx.finish(changed ? "review" : "done_empty", null);
}

function finish(ctx: PassContext, status: TaskRow["status"], reason: string, detail?: string): null {
  ctx.finish(status, reason, detail);
  return null;
}
