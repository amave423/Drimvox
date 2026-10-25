import type { ProjectPlan } from "@drimvox/shared";
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
    "Write the final plan of what one agent will build, alone, from start to finish, after the user says \"Go\". The user",
    "reads it before the work starts and must see the whole result in it, so be specific and complete; everything in the",
    "user's language:",
    "- summary: what we build, for whom and the main decisions from the interview, in 4-10 sentences;",
    "- screens: every page or screen and what is on it: the blocks, the data shown, what the user can do there (2-4 sentences each);",
    "- decisions: the technical choices with a reason for each: the stack, where the data lives, outside services and",
    "  libraries, how it is started and deployed;",
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
      description: "Write the project's final plan: the summary, the screens, the technical decisions, the steps of the work, the checks, the pages and the design.",
      // Generous limits, trimmed when kept: a model that writes a long step should not lose the whole plan (seen live:
      // one step of 230 characters refused it twice and the project failed).
      inputSchema: z.object({
        summary: z.string().min(1).max(20_000),
        steps: z.array(z.string().max(2000)).min(1).max(100),
        checks: z
          .array(z.string().max(2000))
          .max(50)
          .default([])
          .describe("Shell commands that exit 0 when the project works, such as npm test or npm run build; never a description in words"),
        pages: z
          .array(z.object({ url: z.string().max(4000), command: z.string().max(2000).optional() }))
          .max(20)
          .default([]),
        screens: z
          .array(z.object({ name: z.string().max(1000), contents: z.string().max(10_000) }))
          .max(60)
          .default([])
          .describe("Every page or screen and what is on it"),
        decisions: z
          .array(z.object({ what: z.string().max(2000), why: z.string().max(5000) }))
          .max(60)
          .default([])
          .describe("Technical decisions with the reason for each"),
        design: briefInput,
      }),
      execute: async (p) => {
        onPlan({
          context: clip(p.summary, 4000),
          steps: p.steps.map((s) => clip(s, 200)).filter(Boolean).slice(0, 30),
          checks: p.checks.map((c) => c.trim()).filter((c) => c.length <= 500 && isCommand(c)).slice(0, 10),
          pages: p.pages
            .filter((page) => /^https?:\/\//.test(page.url) && page.url.length <= 2000)
            .slice(0, 5)
            .map((page) => ({ url: page.url, command: page.command ? clip(page.command, 500) || undefined : undefined })),
          design: toBrief(p.design),
          screens: p.screens
            .map((x) => ({ name: clip(x.name, 120), contents: clip(x.contents, 1500) }))
            .filter((x) => x.name && x.contents)
            .slice(0, 20),
          decisions: p.decisions
            .map((x) => ({ what: clip(x.what, 200), why: clip(x.why, 600) }))
            .filter((x) => x.what && x.why)
            .slice(0, 20),
        });
        return "Plan written. The user reads it now.";
      },
    }),
  };
}

/** Trimmed to a length, with an ellipsis where it was cut. */
const clip = (text: string, max: number) => (text.trim().length > max ? `${text.trim().slice(0, max - 1).trimEnd()}…` : text.trim());

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
