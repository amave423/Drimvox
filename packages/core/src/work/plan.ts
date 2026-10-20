import type { ProjectPlan } from "@artel/shared";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { briefInput, toBrief } from "../agent/design";
import { finish, type PassContext } from "../agent/pass";
import type { TaskRow } from "../agent/repo";
import { isCommand } from "../backlog/plan";

/**
 * The end of a project's interview: the plan the user reads before "Go" (docs/specs/project-work.md). Its steps become
 * the run's first checklist; the agent keeps the checklist itself from then on.
 */
export const PLAN_NOW = "Nothing more to ask. Write the plan now and call write_plan.";
const PLAN_REMINDER = "You have not written the plan. Call write_plan now.";

export function planInstructions(developer: boolean): string {
  return [
    "Current step: the plan. You may only read the project.",
    developer ? "" : "The user is not a programmer: write the plan in plain words, by what the user will see and do.",
    "Write the final plan of what one agent will build, alone, from start to finish, after the user says \"Go\":",
    "- summary: what we build, for whom and the main decisions from the interview, in 3-8 sentences in the user's language;",
    "- steps: the checklist of the work, 5-20 short items (a few words each), in the order of work, the smallest working",
    "  version first; the last steps check the result for real (run it, look at the pages, go through the main scenarios);",
    "- checks: commands that exit 0 when the project works (build, tests), once they exist; empty if unsure;",
    "- pages: addresses to look at and the command that serves them, if there is an interface;",
    "- the design brief, if there is an interface.",
    "Then call write_plan.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function planTools(onPlan: (plan: ProjectPlan) => void): ToolSet {
  return {
    write_plan: tool({
      description: "Write the project's final plan: the summary, the steps of the work, the checks, the pages and the design.",
      inputSchema: z.object({
        summary: z.string().min(1).max(4000),
        steps: z.array(z.string().min(1).max(200)).min(1).max(30),
        checks: z
          .array(z.string().min(1).max(500))
          .max(10)
          .default([])
          .describe("Shell commands that exit 0 when the project works, such as npm test or npm run build; never a description in words"),
        pages: z
          .array(z.object({ url: z.string().min(1).max(2000), command: z.string().min(1).max(500).optional() }))
          .max(5)
          .default([]),
        design: briefInput,
      }),
      execute: async (p) => {
        onPlan({
          context: p.summary.trim(),
          steps: p.steps.map((s) => s.trim()).filter(Boolean),
          checks: p.checks.map((c) => c.trim()).filter(isCommand),
          pages: p.pages.filter((page) => /^https?:\/\//.test(page.url)).map((page) => ({ url: page.url, command: page.command?.trim() || undefined })),
          design: toBrief(p.design),
        });
        return "Plan written. The user reads it now.";
      },
    }),
  };
}

/** Keeps the plan; the task waits for "Go" or for the user's corrections. */
export function savePlan(ctx: PassContext, id: string, row: TaskRow, plan: ProjectPlan | null, messages: ModelMessage[]): string | null {
  if (!plan) {
    // One reminder; a model that still writes nothing will not write it now.
    if (messages.some((m) => m.role === "user" && m.content === PLAN_REMINDER)) return finish(ctx, "failed", "no_spec");
    return PLAN_REMINDER;
  }
  ctx.backlog.setPlan(row.project_id, plan);
  ctx.work.update(row.project_id, { status: "ready", checklist: (plan.steps ?? []).map((text) => ({ text, done: false })) });
  ctx.event("project_plan", plan);
  ctx.tasks.update(id, { summary: plan.context, design: plan.design ? JSON.stringify(plan.design) : null });
  return finish(ctx, "waiting", "plan_ready");
}

/** The plan is written by the plan's model: the task switches to it once the interview is over. */
export function toPlanStep(ctx: PassContext, id: string, row: TaskRow): void {
  const models = ctx.work.get(row.project_id)?.models;
  if (models) ctx.tasks.update(id, { provider_id: models.plan.providerId, model: models.plan.model });
}
