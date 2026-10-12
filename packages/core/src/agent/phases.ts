import type { Question, TaskPhase } from "@artel/shared";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

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
      ].join("\n");
    case "spec":
      return [
        "Current step: spec. You may only read the project.",
        "Write a short spec in Markdown in the user's language with sections: goal, what changes, out of scope, how we check it.",
        "Find the commands that verify this project (tests, build, type check, lint) in package.json, pyproject.toml, Makefile and similar.",
        "Every check must run from the project root and exit 0 when everything works.",
        "If the project has no tests yet, plan to add the smallest fitting test runner first (node --test for plain Node,",
        "vitest for Vite projects, pytest for Python) and include its command in the checks.",
        "Then call propose_spec with the spec, the checks and a plan of 2-8 short steps.",
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
}

export function specTools(onSpec: (proposal: SpecProposal) => void): ToolSet {
  return {
    propose_spec: tool({
      description: "Propose the spec, the commands that check the work, and the plan.",
      inputSchema: z.object({
        spec: z.string().min(1).max(100_000),
        checks: z.array(z.string().min(1).max(500)).max(20),
        plan: z.array(z.string().min(1).max(500)).max(20).default([]),
      }),
      execute: async (proposal) => {
        onSpec({ spec: proposal.spec, checks: proposal.checks.map((c) => c.trim()), plan: proposal.plan });
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
