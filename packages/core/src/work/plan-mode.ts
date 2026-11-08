import type { ProjectPlan } from "@drimvox/shared";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * The plan as Claude Code makes it (asked for): in the project's own conversation, by its working model, which only reads
 * the project, asks what it must know in its reply, and proposes a short plan; once the user says "Go" the same model goes
 * on in the same conversation with everything it read. Not the old separate interview and form-like plan by other models,
 * after which a fresh conversation got only the plan's text.
 */
export function planModeInstructions(interview: boolean): string {
  return [
    "Plan mode: the user wants to agree on a plan before you change anything. You may only read the project (list_files,",
    "read_file, search), look things up on the web and hand research to sub-agents; you cannot write, edit or run commands",
    "yet.",
    interview
      ? "First ask what you must know and cannot read anywhere: 2 to 6 short questions in your reply, each with 2-4 likely answers to choose from and the one you recommend, then stop and wait. Ask nothing the code or the request already answers. Once the user has answered, write the plan."
      : "Ask nothing unless something essential is missing; assume what is reasonable and say so in the plan.",
    "The plan: call propose_plan with a short plan in Markdown, in the user's language: what you will make or change and",
    "for whom, the main decisions (the stack, where data lives, the look), and the steps in the order of work. As short as",
    "the task: a few lines for a small change, a page at most for a big project. It is a guide, not a contract: you will",
    "follow it with judgement. After propose_plan stop: the user reads it, then says Go or asks for changes.",
  ].join("\n");
}

/** The one tool of the plan mode besides reading: the plan goes to the user as a card with "Go". */
export function planModeTools(onPlan: (plan: ProjectPlan) => void): ToolSet {
  return {
    propose_plan: tool({
      description: "Propose the plan to the user, in Markdown, short; then stop and wait for Go or for changes.",
      inputSchema: z.object({ plan: z.string().min(1).max(20_000).describe("The plan in Markdown, in the user's language") }),
      execute: async ({ plan }) => {
        onPlan({ context: plan.trim(), checks: [], pages: [], design: null });
        return "The plan is with the user. Stop now and wait.";
      },
    }),
  };
}

/** What the user's "Go" says in the conversation: the same model goes on from its plan. */
export const GO_MESSAGE = "Одобряю план — выполняй.";
