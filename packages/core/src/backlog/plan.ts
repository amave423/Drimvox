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
        checks: z.array(z.string().min(1).max(500)).max(10).default([]),
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
            checks: p.checks.map((c) => c.trim()),
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
