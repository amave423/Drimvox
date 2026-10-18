import { backlogSizes, type BacklogItemInput, type ProjectPlan } from "@artel/shared";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { briefInput, toBrief } from "../agent/design";
import { finish, type PassContext } from "../agent/pass";
import type { TaskRow } from "../agent/repo";

/**
 * The end of a project's interview: instead of one spec, the list of everything worth doing, the MVP first
 * (docs/specs/backlog-loop.md). The user then picks a few at a time.
 */
export interface ListProposal {
  plan: ProjectPlan;
  tasks: BacklogItemInput[];
}

export const LIST_NOW = "Nothing more to ask. Make the list of tasks now and call propose_tasks.";

export function listInstructions(developer: boolean): string {
  return [
    "Current step: the task list. You may only read the project.",
    developer ? "" : "The user is not a programmer: name the tasks and their points in plain words, by what the user will see.",
    "List everything worth doing for what the user wants, as separate tasks a single developer does one at a time:",
    "- The first task is the MVP: the smallest version that works end to end and is already useful, nothing more.",
    "- Then the rest, most valuable first: each one a visible step the user can check by hand.",
    "- For each: a short title, 2-6 'done when' points (what the result does, as the user would check it), and a size:",
    "  S (an hour of careful work: a fix, a small screen), M (half a day), L (a day). Split anything bigger.",
    "- 3 to 15 tasks. Do not repeat the MVP's content in later tasks.",
    "Also give: the project's context in 2-5 sentences (what it is, for whom, the main decisions from the interview);",
    "the commands that will check the project once it exists (build, tests; empty if unsure);",
    "and the pages to look at (address and the command that serves them), if it has an interface.",
    "Then call propose_tasks.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function listTools(onList: (proposal: ListProposal) => void): ToolSet {
  return {
    propose_tasks: tool({
      description: "Propose the project's task list (the MVP first), its context, checks and pages.",
      inputSchema: z.object({
        context: z.string().min(1).max(2000),
        tasks: z
          .array(
            z.object({
              title: z.string().min(1).max(160),
              done: z.array(z.string().min(1).max(400)).min(1).max(8).describe("Done when: what the result does"),
              size: z.enum(backlogSizes),
            }),
          )
          .min(1)
          .max(30),
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
        onList({
          plan: {
            context: p.context.trim(),
            checks: p.checks.map((c) => c.trim()).filter(isCommand),
            pages: p.pages.filter((page) => /^https?:\/\//.test(page.url)).map((page) => ({ url: page.url, command: page.command?.trim() || undefined })),
            design: toBrief(p.design),
          },
          tasks: p.tasks.map((t) => ({ title: t.title.trim(), done: t.done.map((d) => d.trim()), size: t.size })),
        });
        return "Task list proposed.";
      },
    }),
  };
}

/**
 * A check is a command a runner understands, not a sentence (seen live: "Кнопка «Старт» запускает отсчёт" was run in
 * PowerShell, failed, and the coder spent half an hour making "the checks" pass).
 */
const RUNNER = /^(npm|npx|pnpm|yarn|bun|node|deno|tsc|vitest|jest|eslint|python3?|py|pytest|pip|uv|go|cargo|dotnet|make|mvn|gradle|gradlew|php|composer|ruby|bundle|rake|flutter|dart|swift)(\.exe|\.cmd)?(\s|$)|^\.{1,2}[\\/]/i;
export const isCommand = (check: string) => RUNNER.test(check.trim());

const LIST_REMINDER = "You have not proposed the task list. Call propose_tasks now.";

/** Keeps the proposed list in the project; the plan is then done and the user picks from the list. */
export function saveList(ctx: PassContext, id: string, row: TaskRow, listed: ListProposal | null, messages: ModelMessage[]): string | null {
  if (!listed) {
    // One reminder; a model that still lists nothing will not start now.
    if (messages.some((m) => m.role === "user" && m.content === LIST_REMINDER)) return finish(ctx, "failed", "no_list");
    return LIST_REMINDER;
  }
  ctx.backlog.add(row.project_id, listed.tasks);
  ctx.backlog.setPlan(row.project_id, listed.plan);
  ctx.event("backlog", { tasks: listed.tasks, plan: listed.plan });
  ctx.tasks.update(id, { summary: listed.plan.context, design: listed.plan.design ? JSON.stringify(listed.plan.design) : null });
  return finish(ctx, "done_empty", "listed");
}

/**
 * What the coder of one task of the list is told (seen live: given "a working timer", it spent half an hour measuring the
 * look, which was a later task, in browsers it started itself).
 */
export function itemInstructions(checks: string[]): string {
  return [
    "This is one task of the project's list. The user checks the result, then picks the next one.",
    "- Do exactly this task: its 'done when' points. Do not do the work of other tasks of the list now.",
    "- Finish as soon as the points hold and the checks pass. Do not polish beyond the points: a reviewer and the user look next.",
    "- If there is an interface, start it and look at the page once or twice with look_at_page (also at width 390 for a phone).",
    "  Do not start browsers or measuring scripts yourself.",
    checks.length
      ? `- Checks (all must exit 0): ${checks.join(" ; ")}. Run them before you finish; Artel runs them again after.`
      : "- The project has no checks yet. If you set up tests or a build, name the commands in your summary.",
    "- Before you finish, keep the project's notes current with update_notes.",
  ].join("\n");
}
