import type { Question, Requirement, TaskPhase, VisualCheck } from "@artel/shared";
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

/** Interview rounds before the agent has to write the spec with what it knows. */
export const MAX_INTERVIEW_ROUNDS = 5;

/** Who the agent talks to: a developer is also asked about technology, everyone else only about the result. */
function audience(developer: boolean): string {
  return developer
    ? "The user is a developer: besides the result, ask about technology, architecture, data storage, integrations and deployment where they matter."
    : "The user is not a programmer: ask only about the result in plain words (what, for whom, how it behaves and looks, what it keeps), " +
        "never about technologies, libraries or architecture. Choose those yourself and list them under decisions in the spec.";
}

export interface PhaseOptions {
  developer: boolean;
  /** The interview round about to be asked. */
  round: number;
}

/** What the model is told on top of the base system prompt in each step. */
export function phaseInstructions(phase: TaskPhase | null, checks: string[], o: PhaseOptions = { developer: true, round: 1 }): string {
  const checkList = checks.length ? checks.map((c) => `- ${c}`).join("\n") : "- (none)";
  switch (phase) {
    case "interview":
      return [
        `Current step: interview, round ${o.round} of at most ${MAX_INTERVIEW_ROUNDS}. You may only read the project.`,
        "The goal is a complete picture of what the user wants before any work starts: whatever stays unclear now ends up guessed.",
        "Explore the project first and never ask what the code already answers.",
        "Cover what the task leaves open, most important first: what exactly should come out and for whom; the main scenarios step by step;",
        "what data it keeps; how it looks and how people use it; what is out of scope.",
        audience(o.developer),
        "Ask about the essence openly: a question with no options lets the user describe it in their own words (use it for things like",
        "\"what exactly should the bot do?\"). Give 2-4 options with a one-line description when there are typical choices, and mark the recommended one.",
        "Call ask_questions with up to 6 questions; in understood say in 2-4 sentences what you understood so far, in unknown list what is",
        "still open. Later rounds build on the answers: ask what they opened up, not the same things again.",
        "When nothing essential is unknown any more, call ask_questions with an empty list. Write in the user's language.",
        ANSWER_HINT,
      ].join("\n");
    case "spec":
      return [
        "Current step: spec. You may only read the project.",
        o.developer ? "" : "The user is not a programmer: write the spec and the requirements in plain words; technical choices go under decisions.",
        "Write a short spec in Markdown in the user's language with sections: goal, what changes, out of scope, how we check it.",
        "Find the commands that verify this project (tests, build, type check, lint) in package.json, pyproject.toml, Makefile and similar.",
        "Every check must run from the project root and exit 0 when everything works.",
        "If the project has no tests yet, plan to add the smallest fitting test runner first (node --test for plain Node,",
        "vitest for Vite projects, pytest for Python) and include its command in the checks.",
        "If the work has a visible interface (a page, a screen), add visual_checks: how to start it, the address and what",
        "must be visible. Artel looks at the page with a model that sees pictures after the checks pass.",
        "List the requirements: numbered, checkable statements about the result (R1, R2…), covering everything the user asked for",
        "and nothing they did not. For each say how it is verified: a check command, a visual check, or review by hand.",
        "A separate reviewer checks every requirement before the work reaches the user. Under decisions list the choices you",
        "made on your own (technologies, defaults, anything the user did not specify).",
        "Then call propose_spec with the spec, the checks, a plan of 2-8 short steps, the requirements and the decisions.",
        ANSWER_HINT,
      ]
        .filter(Boolean)
        .join("\n");
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
  options: z.array(optionSchema).max(4).default([]).describe("2-4 typical choices, or none for an open question answered in the user's own words"),
  recommended: z.number().int().min(0).max(3).nullable().optional(),
});

export interface InterviewRound {
  questions: Question[];
  understood: string;
  unknown: string[];
}

export function interviewTools(onRound: (round: InterviewRound) => void): ToolSet {
  return {
    ask_questions: tool({
      description: "Ask the user the next round of up to 6 questions (open or with options). Pass an empty list once nothing essential is unclear.",
      inputSchema: z.object({
        questions: z.array(questionSchema).max(6),
        understood: z.string().max(4000).default("").describe("What you understood so far, 2-4 sentences in the user's language"),
        unknown: z.array(z.string().min(1).max(500)).max(20).default([]).describe("What is still open"),
      }),
      execute: async ({ questions, understood, unknown }) => {
        onRound({
          understood: understood.trim(),
          unknown,
          questions: questions.map((q) => ({
            id: q.id,
            question: q.question,
            options: q.options.map((o) => ({ label: o.label, description: o.description ?? "" })),
            recommended: q.recommended != null && q.recommended < q.options.length ? q.recommended : null,
          })),
        });
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
  requirements?: Requirement[];
  decisions?: string[];
}

const requirementsInput = z
  .array(
    z.object({
      id: z.string().max(10).optional().describe("R1, R2…; numbered in order when left out"),
      text: z.string().min(1).max(2000).describe("One checkable statement about the result, as the user would put it"),
      verify: z.enum(["check", "visual", "review"]).describe("check: a command or test proves it; visual: a look at a page; review: a reviewer checks it by hand"),
      how: z.string().max(2000).default("").describe("The command, the page and what must be on it, or what to do to see it"),
    }),
  )
  .max(60)
  .default([]);

/** R1, R2… for requirements the model left unnumbered. */
function numbered(items: z.infer<typeof requirementsInput>): Requirement[] {
  return items.map((r, i) => ({ id: r.id?.trim() || `R${i + 1}`, text: r.text.trim(), verify: r.verify, how: r.how.trim() }));
}

/** The requirements as the coder and the reviewer read them. */
export function requirementsText(requirements: Requirement[]): string {
  return requirements.map((r) => `${r.id}. ${r.text}${r.how ? ` (${r.verify}: ${r.how})` : ` (${r.verify})`}`).join("\n");
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
        requirements: requirementsInput,
        decisions: z.array(z.string().min(1).max(1000)).max(30).default([]).describe("Choices you made on your own that the user did not ask for"),
      }),
      execute: async (proposal) => {
        onSpec({
          spec: proposal.spec,
          checks: proposal.checks.map((c) => c.trim()),
          plan: proposal.plan,
          requirements: numbered(proposal.requirements),
          decisions: proposal.decisions.map((d) => d.trim()),
          visualChecks: proposal.visual_checks.flatMap((v) => (/^https?:\/\//.test(v.url) ? [{ ...v, start: v.start?.trim() || undefined }] : [])),
        });
        return "Spec proposed.";
      },
    }),
  };
}

/**
 * The user's answers as a message for what comes next: another round, or the spec, when the rounds ran out or the user
 * said "Enough" (then the agent decides the rest and lists it under decisions).
 */
export function answersMessage(
  questions: Question[],
  answers: { id: string; answer: string }[],
  next: { kind: "round"; round: number } | { kind: "spec"; why: "complete" | "enough" | "rounds" },
): string {
  const lines = answers.map((a) => `- ${questions.find((q) => q.id === a.id)?.question ?? a.id} → ${a.answer}`);
  const head = lines.length ? ["The user answered your questions:", ...lines, ""] : [];
  if (next.kind === "round") {
    return [
      ...head,
      `Now interview round ${next.round}: if anything essential is still unknown, call ask_questions with the next questions, building on`,
      "these answers. If you have the full picture, call ask_questions with an empty list.",
    ].join("\n");
  }
  const tail =
    next.why === "enough"
      ? "The user does not want more questions. Make reasonable choices for everything still open, list them under decisions, and write the spec now."
      : next.why === "rounds"
        ? "That was the last interview round. Make reasonable choices for anything still open, list them under decisions, and write the spec now."
        : "Write the spec now and call propose_spec.";
  return [...head, tail].join("\n");
}

export function specMessage(spec: string, checks: string[], edited: boolean, requirements: Requirement[] = []): string {
  return [
    edited ? "The user approved the spec with their edits. The approved spec:" : "The spec is approved:",
    "",
    spec,
    "",
    ...(requirements.length
      ? ["Requirements (a reviewer checks each one before the user sees the work):", requirementsText(requirements), ""]
      : []),
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
    "List the goal's requirements: numbered, checkable statements about the result (R1, R2…), covering everything the user asked for;",
    "a separate reviewer checks each one once every subtask is merged. Under decisions list the choices you made on your own.",
    "Call propose_plan with the spec, the goal's checks, the subtasks, the requirements, the decisions and a short English commit message for the whole goal.",
    ANSWER_HINT,
  ].join("\n");
}

export interface PlanProposal extends SpecProposal {
  subtasks: { id: string; title: string; description: string; dependsOn: string[]; checks: string[] }[];
  /** What the goal's single commit is called; the task's own words otherwise. */
  commitMessage: string | null;
  requirements: Requirement[];
  decisions: string[];
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
        commit_message: z.string().max(200).optional().describe("Short English commit message in the imperative mood for the whole goal"),
        requirements: requirementsInput,
        decisions: z.array(z.string().min(1).max(1000)).max(30).default([]).describe("Choices you made on your own that the user did not ask for"),
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
