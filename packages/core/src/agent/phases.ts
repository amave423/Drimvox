import type { Question, TaskPhase, VisualCheck } from "@artel/shared";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

/** A question about the project is answered, not turned into a task. */
const ANSWER_HINT =
  "If the user only asks a question (about the project, the code, an idea) and nothing in the project needs to change, " +
  "do not ask questions or write a spec: read what you need, then call answer with the answer in Markdown in the user's language.";

/** Ends a read-only step with an answer to a question instead of a task. */
export function answerTools(onAnswer: (answer: string) => void): ToolSet {
  return {
    answer: tool({
      description: "Answer the user's question when they asked a question rather than for a change in the project.",
      inputSchema: z.object({ answer: z.string().min(1).max(50_000) }),
      execute: async ({ answer }) => {
        onAnswer(answer);
        return "Answered.";
      },
    }),
  };
}

/** What the model is told on top of the base system prompt in each step. */
export function phaseInstructions(phase: TaskPhase | null, checks: string[]): string {
  const checkList = checks.length ? checks.map((c) => `- ${c}`).join("\n") : "- (none)";
  switch (phase) {
    case "interview":
      return [
        "Current step: interview. You may only read the project.",
        "Explore enough to understand the task, then call ask_questions once with up to 6 questions about decisions",
        "only the user can make: scope, behaviour, user interface, technology choices. Skip what the code already answers.",
        "Each question has 2-4 options with a one-line description; mark the recommended option. Write in the user's language.",
        "If the task is already clear, call ask_questions with an empty list.",
        ANSWER_HINT,
      ].join("\n");
    case "spec":
      return [
        "Current step: spec. You may only read the project.",
        "Write a short spec in Markdown in the user's language with sections: goal, what changes, out of scope, how we check it.",
        "Find the commands that verify this project (tests, build, type check, lint) in package.json, pyproject.toml, Makefile and similar.",
        "Every check must run from the project root and exit 0 when everything works.",
        "If the project has no tests yet, plan to add the smallest fitting test runner first (node --test for plain Node,",
        "vitest for Vite projects, pytest for Python) and include its command in the checks.",
        "If the work has a visible interface (a page, a screen), add visual_checks: how to start it, the address and what",
        "must be visible. Artel looks at the page with a model that sees pictures after the checks pass.",
        "Then call propose_spec with the spec, the checks and a plan of 2-8 short steps.",
        ANSWER_HINT,
      ].join("\n");
    case "tests":
      return [
        "Current step: tests first. Do not implement the feature yet.",
        "In this step create or edit only test files and test configuration. Do not touch the source code the tests cover,",
        "and do not create scratch files: Artel checks that the tests fail before any code exists.",
        "Write automated tests for the behaviour in the approved spec; set up the test runner first if the plan says so.",
        "Run the checks yourself: the new tests must fail now, because the feature does not exist yet.",
        `Checks:\n${checkList}`,
        "Then call finish with a short summary of the tests you wrote.",
      ].join("\n");
    case "code":
      return [
        "Current step: implementation. Implement the approved spec so that every check passes.",
        `Checks (all must exit 0):\n${checkList}`,
        "Run the checks yourself before you finish. Artel runs them again after you call finish and sends you any failure.",
        "Do not weaken or delete tests to make them pass.",
      ].join("\n");
    default:
      return "";
  }
}

const optionSchema = z.object({ label: z.string().min(1).max(200), description: z.string().max(500).optional() });
const questionSchema = z.object({
  id: z.string().min(1).max(60),
  question: z.string().min(1).max(1000),
  options: z.array(optionSchema).min(2).max(4),
  recommended: z.number().int().min(0).max(3).nullable().optional(),
});

export function interviewTools(onQuestions: (questions: Question[]) => void): ToolSet {
  return {
    ask_questions: tool({
      description: "Ask the user up to 6 clarifying questions, each with 2-4 options. Pass an empty list if nothing is unclear.",
      inputSchema: z.object({ questions: z.array(questionSchema).max(6) }),
      execute: async ({ questions }) => {
        onQuestions(
          questions.map((q) => ({
            id: q.id,
            question: q.question,
            options: q.options.map((o) => ({ label: o.label, description: o.description ?? "" })),
            recommended: q.recommended != null && q.recommended < q.options.length ? q.recommended : null,
          })),
        );
        return questions.length ? "Questions sent; wait for the answers." : "No questions; move on to the spec.";
      },
    }),
  };
}

export interface SpecProposal {
  spec: string;
  checks: string[];
  plan: string[];
  visualChecks?: VisualCheck[];
}

export function specTools(onSpec: (proposal: SpecProposal) => void): ToolSet {
  return {
    propose_spec: tool({
      description: "Propose the spec, the commands that check the work, and the plan.",
      inputSchema: z.object({
        spec: z.string().min(1).max(100_000),
        checks: z.array(z.string().min(1).max(500)).max(20),
        plan: z.array(z.string().min(1).max(500)).max(20).default([]),
        visual_checks: z
          .array(
            z.object({
              start: z.string().min(1).max(500).optional().describe("Command that starts the app, such as npm run dev; omit for a running one"),
              url: z.string().min(1).max(2000).describe("Address to open, such as http://localhost:5173/"),
              expect: z.string().min(1).max(2000).describe("What must be visible on the page"),
            }),
          )
          .max(5)
          .default([]),
      }),
      execute: async (proposal) => {
        onSpec({
          spec: proposal.spec,
          checks: proposal.checks.map((c) => c.trim()),
          plan: proposal.plan,
          visualChecks: proposal.visual_checks.flatMap((v) => (/^https?:\/\//.test(v.url) ? [{ ...v, start: v.start?.trim() || undefined }] : [])),
        });
        return "Spec proposed.";
      },
    }),
  };
}

/** The user's answers as a message for the next step. */
export function answersMessage(questions: Question[], answers: { id: string; answer: string }[], skipped: boolean): string {
  if (skipped || answers.length === 0) {
    return "The user skipped the interview. Make reasonable choices, note them in the spec, and write the spec now.";
  }
  const lines = answers.map((a) => `- ${questions.find((q) => q.id === a.id)?.question ?? a.id} → ${a.answer}`);
  return ["The user answered your questions:", ...lines, "", "Now write the spec and call propose_spec."].join("\n");
}

export function specMessage(spec: string, checks: string[], edited: boolean): string {
  return [
    edited ? "The user approved the spec with their edits. The approved spec:" : "The spec is approved:",
    "",
    spec,
    "",
    `Checks: ${checks.length ? checks.join(" ; ") : "none"}`,
  ].join("\n");
}

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
    "Call propose_plan with the spec, the goal's checks and the subtasks.",
    ANSWER_HINT,
  ].join("\n");
}

export interface PlanProposal extends SpecProposal {
  subtasks: { id: string; title: string; description: string; dependsOn: string[]; checks: string[] }[];
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
            }),
          )
          .min(1)
          .max(8),
      }),
      execute: async (p) => {
        const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
        const subtasks = p.subtasks.map((s) => ({ ...s, id: slug(s.id), dependsOn: s.dependsOn.map(slug), checks: s.checks.map((c) => c.trim()) }));
        onPlan({ spec: p.spec, checks: p.checks.map((c) => c.trim()), plan: subtasks.map((s) => s.title), subtasks });
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
