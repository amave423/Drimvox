import type { DesignBrief, Milestone, Question, Requirement, TaskPhase, VisualCheck } from "@artel/shared";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { briefInput, lookInput, toBrief, toLook } from "./design";

/** A question about the project is answered, not turned into a task. */
export const ANSWER_HINT =
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
        "If the task is big (more than a day of careful work for an experienced developer, or more than about 10 requirements),",
        "split it into 2-6 stages: stage 1 is the smallest version that works end to end and is useful by itself, each later stage",
        "extends it. Name them in stages and give every requirement its stage. Work and acceptance go stage by stage, and the user",
        "may stop after any stage and keep what is done. A small task has no stages.",
        "Then call propose_spec with the spec, the checks, a plan of 2-8 short steps, the requirements, the decisions and the stages, if any.",
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

const optionSchema = z.object({ label: z.string().min(1).max(200), description: z.string().max(500).optional(), look: lookInput });
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
            options: q.options.map((o) => {
              const look = toLook(o.look);
              return { label: o.label, description: o.description ?? "", ...(look ? { look } : {}) };
            }),
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
  milestones?: Milestone[];
  /** The look the coders follow; null when there is nothing to see or the brief was unusable. */
  design?: DesignBrief | null;
}

export const requirementsInput = z
  .array(
    z.object({
      id: z.string().max(10).optional().describe("R1, R2…; numbered in order when left out"),
      text: z.string().min(1).max(2000).describe("One checkable statement about the result, as the user would put it"),
      verify: z.enum(["check", "visual", "review"]).describe("check: a command or test proves it; visual: a look at a page; review: a reviewer checks it by hand"),
      how: z.string().max(2000).default("").describe("The command, the page and what must be on it, or what to do to see it"),
      stage: z.number().int().min(1).max(10).optional().describe("For a task in stages: the stage that delivers it"),
    }),
  )
  .max(60)
  .default([]);

/** R1, R2… for requirements the model left unnumbered. */
export function numbered(items: z.infer<typeof requirementsInput>): Requirement[] {
  return items.map((r, i) => ({
    id: r.id?.trim() || `R${i + 1}`,
    text: r.text.trim(),
    verify: r.verify,
    how: r.how.trim(),
    ...(r.stage ? { stage: r.stage } : {}),
  }));
}

export const stagesInput = z
  .array(z.object({ title: z.string().min(1).max(300) }))
  .max(6)
  .default([])
  .describe("For a big task: its stages in order; empty for a task done in one go");

/** Stage titles as given, when there are at least two of them. */
export function milestonesOf(stages: { title: string }[]): Milestone[] {
  return stages.length > 1 ? stages.map((s) => ({ title: s.title.trim() })) : [];
}

/** The requirements a stage is accepted on: its own and every earlier stage's. */
export function requirementsUpTo(requirements: Requirement[], stage: number): Requirement[] {
  return requirements.filter((r) => (r.stage ?? 1) <= stage);
}

/** What the coder is told at the start of a stage of a big task. */
export function stageNote(milestones: Milestone[], requirements: Requirement[], stage: number): string {
  if (milestones.length < 2) return "";
  const own = requirements.filter((r) => (r.stage ?? 1) === stage);
  return [
    `The work goes in ${milestones.length} stages. Now stage ${stage} of ${milestones.length}: ${milestones[stage - 1]?.title ?? ""}.`,
    own.length ? `Its requirements:\n${requirementsText(own)}` : "",
    "Do only this stage; the later ones come after it is accepted, and everything from earlier stages must keep working.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The requirements as the coder and the reviewer read them. */
export function requirementsText(requirements: Requirement[]): string {
  return requirements.map((r) => `${r.id}. ${r.text}${r.how ? ` (${r.verify}: ${r.how})` : ` (${r.verify})`}`).join("\n");
}

/** Pages to look at: how to start the app, its address and what must be on it. */
export const pagesInput = z
  .array(
    z.object({
      start: z.string().min(1).max(500).optional().describe("Command that starts the app, such as npm run dev; omit for a running one"),
      url: z.string().min(1).max(2000).describe("Address to open, such as http://localhost:5173/"),
      expect: z.string().min(1).max(2000).describe("What must be visible on the page"),
    }),
  )
  .max(5)
  .default([]);

/** Pages with a web address; anything else cannot be opened. */
export function pagesOf(pages: z.infer<typeof pagesInput>): VisualCheck[] {
  return pages.flatMap((v) => (/^https?:\/\//.test(v.url) ? [{ ...v, start: v.start?.trim() || undefined }] : []));
}

export function specTools(onSpec: (proposal: SpecProposal) => void): ToolSet {
  return {
    propose_spec: tool({
      description: "Propose the spec, the commands that check the work, and the plan.",
      inputSchema: z.object({
        spec: z.string().min(1).max(100_000),
        checks: z.array(z.string().min(1).max(500)).max(20),
        plan: z.array(z.string().min(1).max(500)).max(20).default([]),
        visual_checks: pagesInput,
        requirements: requirementsInput,
        decisions: z.array(z.string().min(1).max(1000)).max(30).default([]).describe("Choices you made on your own that the user did not ask for"),
        stages: stagesInput,
        design: briefInput,
      }),
      execute: async (proposal) => {
        onSpec({
          spec: proposal.spec,
          checks: proposal.checks.map((c) => c.trim()),
          plan: proposal.plan,
          requirements: numbered(proposal.requirements),
          decisions: proposal.decisions.map((d) => d.trim()),
          milestones: milestonesOf(proposal.stages),
          visualChecks: pagesOf(proposal.visual_checks),
          design: toBrief(proposal.design),
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

export function specMessage(spec: string, checks: string[], edited: boolean, requirements: Requirement[] = [], milestones: Milestone[] = []): string {
  const note = stageNote(milestones, requirements, 1);
  return [
    edited ? "The user approved the spec with their edits. The approved spec:" : "The spec is approved:",
    "",
    spec,
    "",
    ...(requirements.length
      ? ["Requirements (a reviewer checks each one before the user sees the work):", requirementsText(requirements), ""]
      : []),
    `Checks: ${checks.length ? checks.join(" ; ") : "none"}`,
    ...(note ? ["", note] : []),
  ].join("\n");
}
