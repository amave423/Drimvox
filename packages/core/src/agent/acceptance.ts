import type { AcceptanceReport, AcceptanceResult, ModelInfo, ProviderError, Requirement } from "@artel/shared";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { isCli } from "../cli/kinds";
import { runCliTurn } from "../cli/turn";
import type { Connection } from "../providers/repo";
import { todayLine } from "../now";
import { requirementsText } from "./phases";
import { runAgent, type RunInput } from "./run";

/** Acceptance rounds before the work goes to the user anyway, with an honest report. */
export const MAX_ACCEPTANCE_ROUNDS = 3;

const VERDICT_REMINDER = "You have not given a verdict. Call report_acceptance now with a result for every requirement.";

function systemPrompt(root: string, platform = process.platform): string {
  const shell = platform === "win32" ? "Windows PowerShell 5.1 (no && or ||: separate commands with ; or use if ($?) { ... })" : "sh";
  return [
    "You are the acceptance agent in Artel. Another agent wrote the code; you did not, and you must not change it.",
    `The work is in a copy of the project at: ${root}`,
    todayLine(),
    `Commands run with ${shell} in that folder.`,
    "",
    "Check every requirement against what was actually built:",
    "- read the code that implements it;",
    "- run what proves it: the tests, the program itself with real input, a request to the server (start it with start_background",
    "  and stop it afterwards), a page with look_at_page when it has an interface;",
    "- trust what you saw, not what the code or the other agent's summary claims.",
    "Mark a requirement done only with evidence. Partial: it works in some cases or only part of it is there. Missing: absent or broken.",
    "Do not edit files and do not try to fix anything: describe what is wrong precisely enough for the coder to fix it.",
    "Leave the project as you found it: delete anything you created only to check.",
    "Finish by calling report_acceptance once, with a result for every requirement and a short summary in the user's language.",
  ].join("\n");
}

/** What the acceptance agent is asked: the task as the user put it, the spec and the requirements. */
function brief(i: AcceptanceInput): string {
  const { task, spec, requirements, decisions, round } = i;
  return [
    `Accept the work on this task (acceptance round ${round}).`,
    "",
    "The user's task:",
    task,
    "",
    spec ? `The approved spec:\n${spec}\n` : "",
    "Requirements:",
    requirementsText(requirements),
    decisions.length ? `\nChoices the coder made on its own (not requirements):\n${decisions.map((d) => `- ${d}`).join("\n")}` : "",
    // Seen live: stage 1 was sent back for the detail pages of stage 2.
    i.later.length ? `\n${laterText(i.later)}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The stages still to come: the spec describes them, but they are no reason to send this stage back. */
function laterText(later: AcceptanceInput["later"]): string {
  const stages = later.map((s) => [`- ${s.title}`, ...s.requirements.map((r) => `  - ${r}`)].join("\n"));
  return [
    "Later stages, not expected yet: the work goes in stages and these come after this one is accepted.",
    "Do not mark a requirement partial or missing for what they will add (a button may lead nowhere yet).",
    ...stages,
  ].join("\n");
}

function verdictTools(requirements: Requirement[], onReport: (r: { results: AcceptanceResult[]; summary: string }) => void): ToolSet {
  return {
    report_acceptance: tool({
      description: "Give the verdict: one result for every requirement, with evidence, and a short summary.",
      inputSchema: z.object({
        results: z
          .array(
            z.object({
              id: z.string().min(1).max(10),
              status: z.enum(["done", "partial", "missing"]),
              evidence: z.string().max(4000).default(""),
              problem: z.string().max(4000).default(""),
            }),
          )
          .min(1)
          .max(60),
        summary: z.string().min(1).max(4000),
      }),
      execute: async ({ results, summary }) => {
        // A requirement the agent did not mention is unchecked: not accepted, and no reason to redo the work (seen live:
        // a forced verdict named three of fourteen, and the coder was about to redo eleven that were done).
        const byId = new Map(results.map((r) => [r.id.trim(), r]));
        const full = requirements.map(
          (req): AcceptanceResult =>
            byId.get(req.id) ?? { id: req.id, status: "unchecked", evidence: "", problem: "The reviewer did not check this." },
        );
        onReport({ results: full, summary });
        return "Verdict recorded.";
      },
    }),
  };
}

export interface AcceptanceInput {
  conn: Connection;
  model: string;
  price: ModelInfo | undefined;
  worktree: string;
  task: string;
  spec: string | null;
  requirements: Requirement[];
  decisions: string[];
  round: number;
  /** Background processes and page screenshots, as the coder has them. */
  ownTools: ToolSet;
  /** The stages after this one, for a task in stages. */
  later: { title: string; requirements: string[] }[];
  /** Steps of one look at the work; the run's default when not given. */
  maxSteps?: number;
  spentUsd: number;
  budgetUsd: number;
  signal: AbortSignal;
  idleTimeoutMs: number;
  hooks: RunInput["hooks"];
  onStep: RunInput["onStep"];
  /** What the acceptance agent says between its checks, for the feed. */
  onText(text: string): void;
}

export type AcceptanceOutcome =
  | { kind: "report"; report: AcceptanceReport }
  /** The agent ended without a verdict even after a reminder: says nothing about the work, only about the agent. */
  | { kind: "no_verdict" }
  | { kind: "stopped" }
  | { kind: "budget" }
  | { kind: "error"; error: ProviderError };

/** One acceptance round: a separate agent reads, runs and looks, then gives a verdict per requirement. */
export async function runAcceptance(i: AcceptanceInput): Promise<AcceptanceOutcome> {
  let verdict: { results: AcceptanceResult[]; summary: string } | null = null;
  const messages: RunInput["messages"] = [{ role: "user", content: brief(i) }];
  for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
    if (attempt > 0) messages.push({ role: "user", content: VERDICT_REMINDER });
    const input: RunInput = {
      conn: i.conn,
      model: i.model,
      price: i.price,
      worktree: i.worktree,
      messages,
      mode: "review",
      extraTools: verdictTools(i.requirements, (v) => (verdict = v)),
      ownTools: i.ownTools,
      stopTools: ["report_acceptance"],
      // Seen live: reminded, the agent went on looking until its steps ran out again. The second time it has the
      // verdict only, and must give it.
      ...(attempt > 0 ? { only: "report_acceptance" } : {}),
      maxSteps: i.maxSteps,
      system: systemPrompt(i.worktree),
      spentUsd: i.spentUsd,
      budgetUsd: i.budgetUsd,
      signal: i.signal,
      idleTimeoutMs: i.idleTimeoutMs,
      hooks: i.hooks,
      onText: i.onText,
      onStep: (step) => {
        messages.push(...step.messages);
        i.onStep(step);
      },
    };
    const outcome = isCli(i.conn.preset) ? await runCliTurn({ ...input, session: null, onSession: () => {} }) : await runAgent(input);
    if (outcome.kind === "stopped") return { kind: "stopped" };
    // Told to give the verdict and nothing else, a model that still only talks gives none: the next model accepts.
    if (outcome.kind === "error" && attempt > 0 && /tool choice was required/i.test(outcome.error.detail ?? "")) break;
    if (outcome.kind === "error") return { kind: "error", error: outcome.error };
    if (outcome.kind === "budget") return { kind: "budget" };
  }
  const given = verdict as { results: AcceptanceResult[]; summary: string } | null;
  if (!given) return { kind: "no_verdict" };
  return { kind: "report", report: { round: i.round, results: given.results, summary: given.summary, model: i.model } };
}

export function accepted(report: AcceptanceReport): boolean {
  return report.results.every((r) => r.status === "done");
}

/** What the coder has to redo: partly done or missing, not what went unchecked. */
export function problems(report: AcceptanceReport): AcceptanceResult[] {
  return report.results.filter((r) => r.status === "partial" || r.status === "missing");
}

/** What goes back to the coder after a round that found unmet requirements. */
export function reworkMessage(report: AcceptanceReport, requirements: Requirement[]): string {
  const lines = problems(report)
    .map((r) => {
      const req = requirements.find((q) => q.id === r.id);
      return `- ${r.id} (${r.status}): ${req?.text ?? ""}\n  Problem: ${r.problem || "—"}${r.evidence ? `\n  Seen: ${r.evidence}` : ""}`;
    });
  return [
    "A reviewer checked the work against the requirements and these are not met yet:",
    "",
    ...lines,
    "",
    "Fix every one of them (not the tests), run the checks, then call finish.",
  ].join("\n");
}
