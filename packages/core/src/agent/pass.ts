import type { BacklogRepo } from "../backlog/repo";
import { itemInstructions } from "../backlog/plan";
import type { ProjectWorkRepo } from "../work/repo";
import { PLAN_NOW, planInstructions as projectPlanInstructions, planTools as projectPlanTools, savePlan, toPlanStep } from "../work/plan";
import type { Memory } from "./memory";
import type { DesignBrief, ProjectPlan, TaskEvent, TaskPhase, TaskStages } from "@drimvox/shared";
import type { ModelMessage, ToolSet } from "ai";
import { findModel } from "../providers/catalog";
import type { ProviderRepo } from "../providers/repo";
import { failureReport, runChecks, safeChecks } from "./checks";
import {
  answerTools,
  interviewTools,
  phaseInstructions,
  specMessage,
  specTools,
  type InterviewRound,
  type SpecProposal,
} from "./phases";
import { briefInstructions, designInstructions, lookInstructions } from "./design";
import { planInstructions, planTools, type PlanProposal } from "./plan";
import type { ProjectRepo, TaskRepo, TaskRow } from "./repo";
import { done, lastSummary } from "./landing";
import { MAX_STEPS, runAgent } from "./run";
import { escalate, GREEN, pastStepLimit } from "./progress";
import { isCli } from "../cli/kinds";
import { runCliTurn } from "../cli/turn";
import { webTools } from "../internet/tools";
import type { Vision } from "../visual/look";
import { runVisualChecks, visualTools, type VisualDeps, type VisualKit } from "../visual/tools";
import { findSkills, projectSkillRoots, skillsInstructions, skillTools } from "../skills/skills";
import type { WebAccess } from "../internet/web";
import type { ToolHooks } from "./tools";

const SPEC_REMINDER = "You must call propose_spec with the spec, the checks and the plan.";
const PLAN_REMINDER = "You must call propose_plan with the spec, the checks and the subtasks.";

/** Red check rounds in a row before a task escalates or stops. */
export const MAX_ATTEMPTS = 3;
/** A task goes past the step limit this many times before it asks; the budget limits it anyway. */
export const MAX_STEP_ROUNDS = 3;

/** What a pass needs from the runner: storage, notifications and the user's settings. */
export interface PassContext {
  tasks: TaskRepo;
  projects: ProjectRepo;
  providers: ProviderRepo;
  /** Where the project's plan is kept. */
  backlog: BacklogRepo;
  /** The project's work: who writes the plan, and the checklist the plan starts. */
  work: ProjectWorkRepo;
  idleTimeoutMs: number;
  strongModel(): { providerId: string; model: string } | null;
  /** The user writes code: the interview may ask about technology. */
  developer(): boolean;
  /** Who accepts the work: the acceptance model from the settings, else the strong one; null means the task's own. */
  acceptanceModel(): { providerId: string; model: string } | null;
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
  /** Shared skills of Drimvox; the project's own are found in the copy. */
  skillsDir: string;
  /** Tools of the user's MCP servers; the first call of each asks the user. */
  mcpTools(hooks: Omit<ToolHooks, "onFinish" | "askApproval">): Promise<ToolSet>;
  /** Background processes, screenshots and where they are kept. */
  visualKit: VisualKit;
  /** The model that looks at screenshots for this task, if there is one. */
  vision(row: TaskRow): Promise<Vision | null>;
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
  ctx.tasks.update(id, { phase, attempts: 0, step_red: null });
  ctx.event("phase", { phase });
}

/**
 * One model pass in the task's current step, then Drimvox's own decision about what comes next.
 * Returns the message that starts the next pass, or null when the task now waits or is done.
 */
/** An interviewer that wrote its questions as text is asked once to ask them with the tool. */
export const QUESTIONS_AS_TEXT =
  "You wrote your questions as text: the user cannot answer them there. Call ask_questions with them (each with short options and the recommended one), or ask_questions with an empty list if there is nothing to ask.";

export async function runPass(ctx: PassContext, id: string, userText: string, fromDrimvox = false): Promise<string | null> {
  const row = ctx.tasks.row(id)!;
  const phase = row.phase;
  const messages: ModelMessage[] = [...ctx.tasks.messages(id), { role: "user", content: userText }];
  ctx.tasks.update(id, { messages: JSON.stringify(messages) });
  // Drimvox's own nudges to the model ("write the plan now") are marked: the feed does not show them as the user's words
  // (seen live: English instructions to the model appeared in the user's feed).
  ctx.event("user", fromDrimvox ? { text: userText, drimvox: true } : { text: userText });
  ctx.setStatus("running", null);

  const conn = row.provider_id ? ctx.providers.connection(row.provider_id) : null;
  if (!conn) return finish(ctx, "failed", "no_provider");

  let round: InterviewRound | null = null;
  let proposal: SpecProposal | null = null;
  let teamPlan: PlanProposal | null = null;
  let answered: string | null = null;
  let written: ProjectPlan | null = null;
  const planning = row.kind === "goal" && phase === "spec";
  let extraTools: ToolSet | undefined;
  let stopTools: string[] | undefined;
  if (phase === "interview") {
    extraTools = interviewTools((r) => (round = r));
    stopTools = ["ask_questions"];
  } else if (planning) {
    extraTools = planTools((p) => (teamPlan = p));
    stopTools = ["propose_plan"];
  } else if (phase === "list") {
    extraTools = projectPlanTools((p) => (written = p));
    stopTools = ["write_plan"];
  } else if (phase === "spec") {
    extraTools = specTools((p) => (proposal = p));
    stopTools = ["propose_spec"];
  }
  if (phase === "interview" || phase === "spec") {
    extraTools = { ...extraTools, ...answerTools((a) => (answered = a)) };
    stopTools = [...(stopTools ?? []), "answer"];
  }

  /** What the model said in this pass: questions written as text, or nothing at all. */
  let said = "";
  let called = false;
  let cost = row.cost_usd;
  let input = row.input_tokens;
  let output = row.output_tokens;
  let steps = row.steps;
  const hooks = {
    onCall: (call: { callId: string; name: string; input: unknown }) => ctx.event("tool_call", call),
    onResult: (result: { callId: string; name: string; ok: boolean; output: string }) => ctx.event("tool_result", result),
    askApproval: ctx.askApproval,
  };
  const mode = phase === "interview" || phase === "spec" || phase === "list" ? "read" : "write";
  // Pictures and screenshots cost money outside the model's own usage: they go into the task's spending at once.
  const spend = (usd: number) => {
    if (usd <= 0) return;
    cost += usd;
    ctx.tasks.update(id, { cost_usd: cost });
    ctx.tasks.addUsage(id, 0, 0, usd, true);
    ctx.publish();
  };
  const visual: VisualDeps = {
    kit: ctx.visualKit,
    taskId: id,
    worktree: row.worktree,
    vision: await ctx.vision(row),
    hooks,
    onSpend: spend,
    event: (kind, data) => ctx.event(kind, data),
  };
  // The project's skills first: they win over shared ones of the same name.
  const skills = findSkills([...projectSkillRoots(row.worktree), { dir: ctx.skillsDir, scope: "shared" }]);
  let ownTools: ToolSet = { ...webTools(ctx.web, hooks, { local: true }), ...skillTools(skills, row.worktree, hooks), ...(await ctx.mcpTools(hooks)) };
  if (mode === "write") {
    ownTools = { ...ownTools, ...(await ctx.imageTools(row, hooks, spend, () => row.budget_usd - cost)), ...visualTools(visual) };
  }
  // The look: asked about in the interview, written down with the spec, followed while coding.
  const brief = row.design ? (JSON.parse(row.design) as DesignBrief) : null;
  const designNote =
    phase === "interview" ? lookInstructions() : (phase === "spec" && !planning) || phase === "list" ? briefInstructions() : phase === "code" && brief ? designInstructions(brief) : "";
  // Claude Code, Codex and Gemini CLI work with their own tools; Drimvox's own (web, skills, MCP, pictures) are for API models.
  const run = isCli(conn.preset) ? runCliTurn : runAgent;
  const outcome = await run({
    session: row.cli_session,
    onSession: (stored) => ctx.tasks.update(id, { cli_session: stored }),
    conn,
    model: row.model,
    price: await findModel(conn, row.model),
    worktree: row.worktree,
    messages,
    memory: row.memory ? (JSON.parse(row.memory) as Memory) : null,
    onMemory: (memory, usage) => {
      if (ctx.closed()) return;
      cost += usage.costUsd;
      input += usage.inputTokens;
      output += usage.outputTokens;
      ctx.tasks.update(id, { memory: JSON.stringify(memory), cost_usd: cost, input_tokens: input, output_tokens: output });
      ctx.tasks.addUsage(id, usage.inputTokens, usage.outputTokens, usage.costUsd, true);
      ctx.event("text", { text: "Drimvox summarized the older work to keep the conversation within the model's memory." });
    },
    mode,
    extraTools,
    ownTools,
    stopTools,
    instructions: [
      planning
        ? planInstructions()
        : phase === "list"
          ? projectPlanInstructions(ctx.developer())
          : row.kind === "item"
            ? itemInstructions(JSON.parse(row.checks) as string[])
            : phaseInstructions(phase, JSON.parse(row.checks) as string[], { developer: ctx.developer(), round: row.interview_round + 1 }),
      designNote,
      skillsInstructions(skills),
    ]
      .filter(Boolean)
      .join("\n\n"),
    // Team workers follow a settled plan: the lead and the acceptance agent do the thinking.
    thinking: row.kind !== "subtask",
    spentUsd: row.cost_usd,
    budgetUsd: row.budget_usd,
    signal: ctx.signal,
    idleTimeoutMs: ctx.idleTimeoutMs,
    onText: (text) => {
      said += text;
      ctx.event("text", { text });
    },
    onStep: (step) => {
      if (ctx.closed()) return;
      messages.push(...step.messages);
      if (step.messages.some((m) => m.role === "tool")) called = true;
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
  // The step limit means nothing to the user: the stops worth making are the spec and the stages, and the budget limits money.
  if (outcome.kind === "steps" && row.step_rounds < MAX_STEP_ROUNDS) {
    const next = await pastStepLimit(ctx, id, ctx.tasks.row(id)!, MAX_STEPS);
    if (next !== GREEN) return next;
    ctx.event("text", { text: `The checks pass after ${MAX_STEPS} more steps: Drimvox takes the work as done and reviews it.` });
    return done(ctx, id, ctx.tasks.row(id)!, visual, lastSummary(ctx, id), null);
  }
  if (outcome.kind === "budget" || outcome.kind === "steps") return finish(ctx, "waiting", outcome.kind);

  // A question, not a task: the answer is the result and there is nothing to review.
  const answer = answered as string | null;
  if (answer !== null) {
    ctx.tasks.update(id, { summary: answer });
    ctx.event("answer", { text: answer });
    return finish(ctx, "done_empty", "answered");
  }

  const stages = JSON.parse(row.stages) as TaskStages;
  const asked = round as InterviewRound | null;
  const proposed = proposal as SpecProposal | null;

  if (phase === "interview") {
    if (asked) ctx.tasks.update(id, { interview_notes: JSON.stringify({ understood: asked.understood, unknown: asked.unknown }) });
    if (asked && asked.questions.length > 0) {
      ctx.tasks.update(id, { questions: JSON.stringify(asked.questions), interview_round: row.interview_round + 1 });
      ctx.event("questions", { questions: asked.questions, understood: asked.understood, unknown: asked.unknown, round: row.interview_round + 1 });
      return finish(ctx, "waiting", "questions");
    }
    // Questions written as text instead of ask_questions (seen live: they were lost and the plan came without them).
    if (!asked && said.includes("?") && !messages.some((m) => m.role === "user" && m.content === QUESTIONS_AS_TEXT)) return QUESTIONS_AS_TEXT;
    if (row.kind === "plan") {
      enterPhase(ctx, id, "list");
      toPlanStep(ctx, id, row);
      return PLAN_NOW;
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
      ...(planned.commitMessage ? { commit_message: planned.commitMessage } : {}),
      requirements: JSON.stringify(planned.requirements),
      decisions: JSON.stringify(planned.decisions),
      milestones: JSON.stringify(planned.milestones),
      milestone: 1,
      design: planned.design ? JSON.stringify(planned.design) : null,
      visual: JSON.stringify(planned.visualChecks ?? []),
    });
    ctx.event("plan", { spec: planned.spec, checks: planned.checks, subtasks: planned.subtasks });
    if (stages.approveSpec) return finish(ctx, "waiting", "plan_review");
    const { kept } = safeChecks(planned.checks, row.worktree);
    ctx.tasks.update(id, { checks: JSON.stringify(kept) });
    ctx.startTeam();
    return null;
  }

  if (phase === "list") return savePlan(ctx, id, row, written as ProjectPlan | null, messages, !said.trim() && !called);

  if (phase === "spec") {
    if (!proposed) {
      // One reminder; a model that still writes no spec will not start writing one.
      if (messages.some((m) => m.role === "user" && m.content === SPEC_REMINDER)) return finish(ctx, "failed", !said.trim() && !called ? "empty_answer" : "no_spec");
      return SPEC_REMINDER;
    }
    ctx.tasks.update(id, {
      spec: proposed.spec,
      checks: JSON.stringify(proposed.checks),
      plan: JSON.stringify(proposed.plan),
      visual: JSON.stringify(proposed.visualChecks ?? []),
      requirements: JSON.stringify(proposed.requirements ?? []),
      decisions: JSON.stringify(proposed.decisions ?? []),
      milestones: JSON.stringify(proposed.milestones ?? []),
      milestone: 1,
      design: proposed.design ? JSON.stringify(proposed.design) : null,
    });
    ctx.event("spec", proposed);
    if (stages.approveSpec) return finish(ctx, "waiting", "spec_review");
    const { kept, dropped } = safeChecks(proposed.checks, row.worktree);
    ctx.tasks.update(id, { checks: JSON.stringify(kept) });
    if (dropped.length) ctx.event("text", { text: `Drimvox removed checks that would need permission: ${dropped.join(", ")}` });
    return startWork(ctx, id, stages, specMessage(proposed.spec, kept, false, proposed.requirements, proposed.milestones), kept);
  }

  const checks = JSON.parse(row.checks) as string[];
  if (phase === "tests") return testsGate(ctx, id, row, checks);
  if (phase === "code" && checks.length > 0) return codeGate(ctx, id, row, checks, visual, outcome.commitMessage ? outcome : null);
  return done(ctx, id, row, visual, outcome.summary, outcome.commitMessage);
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

/** Work counts as done only when Drimvox's own run of the checks is green. */
async function codeGate(
  ctx: PassContext,
  id: string,
  row: TaskRow,
  checks: string[],
  visual: VisualDeps,
  /** The pass's own summary and commit message, when it gave them. */
  ended: { summary: string; commitMessage: string | null } | null,
): Promise<string | null> {
  const results = await check(ctx, "code", checks, row.worktree);
  if (ctx.signal.aborted) return finish(ctx, "stopped", "user");
  if (results.every((r) => r.ok)) return done(ctx, id, row, visual, ended?.summary ?? lastSummary(ctx, id), ended?.commitMessage ?? null);
  const report = failureReport(results);
  const attempts = row.attempts + 1;
  if (attempts < MAX_ATTEMPTS) {
    ctx.tasks.update(id, { attempts });
    return `Drimvox ran the checks and they fail:\n\n${report}\n\nFix the cause (not the tests), run the checks, then call finish.`;
  }

  const handOver = escalate(ctx, id, row, `failed ${MAX_ATTEMPTS} times`, report);
  if (handOver) return handOver;
  ctx.tasks.update(id, { attempts });
  return finish(ctx, "waiting", "stuck", report.slice(0, 4000));
}

export function finish(ctx: PassContext, status: TaskRow["status"], reason: string, detail?: string): null {
  ctx.finish(status, reason, detail);
  return null;
}
