import type { Milestone, Requirement } from "@artel/shared";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { briefInput, briefInstructions, teamDesignNote, toBrief } from "./design";
import { ANSWER_HINT, milestonesOf, numbered, pagesInput, pagesOf, requirementsInput, stagesInput, type SpecProposal } from "./phases";

/** What the lead agent is told when it plans a goal for a team. */
export function planInstructions(): string {
  return [
    "Current step: plan for a team. You lead several coding agents; you may only read the project.",
    "Write a short spec in Markdown in the user's language (goal, what changes, out of scope, how we check it)",
    "and the goal's checks: commands that exit 0 once all the work is done (tests, build, type check).",
    "Then split the work into 2-8 subtasks that separate agents can do at the same time in separate copies of the project:",
    "- id: a short slug such as auth-api; title; description: what to do, which files, how to tell it is done;",
    "- dependsOn: ids of subtasks whose work this one needs; it starts only after they are merged;",
    "- checks: commands that exit 0 once this subtask is done, with only the subtasks it depends on merged,",
    "  for example `node --test strings.test.js`. Never a check that needs work from another subtask.",
    "Plan subtasks that touch different files, shared files such as package.json included.",
    "If two must edit the same file, make one depend on the other.",
    "If the project has no tests yet, the first subtask sets up the test runner and the others depend on it.",
    "If the goal is big, split it into 2-6 stages: stage 1 is the smallest version that works end to end, later stages extend it.",
    "Give every requirement and every subtask its stage; the team does and accepts one stage at a time, and the user may stop after any.",
    "List the goal's requirements: numbered, checkable statements about the result (R1, R2…), covering everything the user asked for;",
    "a separate reviewer checks each one once every subtask is merged. Under decisions list the choices you made on your own.",
    briefInstructions(),
    teamDesignNote(),
    "Call propose_plan with the spec, the goal's checks, the subtasks, the requirements, the decisions, the design and visual checks",
    "when there is an interface, and a short English commit message for the whole goal.",
    ANSWER_HINT,
  ].join("\n");
}

export interface PlanProposal extends SpecProposal {
  subtasks: { id: string; title: string; description: string; dependsOn: string[]; checks: string[] }[];
  /** What the goal's single commit is called; the task's own words otherwise. */
  commitMessage: string | null;
  requirements: Requirement[];
  decisions: string[];
  milestones: Milestone[];
}

export function planTools(onPlan: (proposal: PlanProposal) => void): ToolSet {
  return {
    propose_plan: tool({
      description: "Propose the spec, the commands that check the work, and the subtasks for the team.",
      inputSchema: z.object({
        spec: z.string().min(1).max(100_000),
        checks: z.array(z.string().min(1).max(500)).max(20),
        subtasks: z
          .array(
            z.object({
              id: z.string().min(1).max(40),
              title: z.string().min(1).max(200),
              description: z.string().min(1).max(10_000),
              dependsOn: z.array(z.string()).max(8).default([]),
              checks: z.array(z.string().min(1).max(500)).max(10).default([]),
              stage: z.number().int().min(1).max(10).optional().describe("For a goal in stages: the stage this subtask belongs to"),
            }),
          )
          .min(1)
          .max(8),
        commit_message: z.string().max(200).optional().describe("Short English commit message in the imperative mood for the whole goal"),
        requirements: requirementsInput,
        decisions: z.array(z.string().min(1).max(1000)).max(30).default([]).describe("Choices you made on your own that the user did not ask for"),
        stages: stagesInput,
        design: briefInput,
        visual_checks: pagesInput,
      }),
      execute: async (p) => {
        const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
        const subtasks = p.subtasks.map((s) => ({ ...s, id: slug(s.id), dependsOn: s.dependsOn.map(slug), checks: s.checks.map((c) => c.trim()) }));
        onPlan({
          spec: p.spec,
          checks: p.checks.map((c) => c.trim()),
          plan: subtasks.map((s) => s.title),
          subtasks,
          commitMessage: p.commit_message?.split("\n")[0]?.trim() || null,
          requirements: numbered(p.requirements),
          decisions: p.decisions.map((d) => d.trim()),
          milestones: milestonesOf(p.stages),
          design: toBrief(p.design),
          visualChecks: pagesOf(p.visual_checks),
        });
        return "Plan proposed.";
      },
    }),
  };
}

/** The first message of a subtask: its part, its checks, and the goal around it. */
export function subtaskBrief(
  sub: { planId: string; title: string; description: string; checks: string[] },
  goal: { spec: string; checks: string[] },
  others: { planId: string; title: string }[],
  rebuild: string | null,
): string {
  return [
    "You are one agent in a team working on a shared goal. Other agents do the other subtasks in parallel;",
    "do only yours and do not create files that belong to their subtasks.",
    `Subtask id: ${sub.planId}`,
    `Your subtask: ${sub.title}`,
    sub.description,
    "",
    "The goal, for context:",
    goal.spec,
    "",
    others.length ? `Other subtasks (not yours): ${others.map((o) => `${o.title} [${o.planId}]`).join("; ")}` : "",
    `Your checks (they must pass when you finish): ${sub.checks.length ? sub.checks.join(" ; ") : "none"}`,
    `The goal's checks, for when every subtask is merged: ${goal.checks.length ? goal.checks.join(" ; ") : "none"}`,
    rebuild ? `\n${rebuild}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
