import type { ModelInfo } from "@drimvox/shared";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { runAgent } from "../agent/run";
import type { ToolHooks } from "../agent/tools";
import type { Connection } from "../providers/repo";

/**
 * The code reviewer (asked for after a video on harnesses, with a switch, off by default): a fresh agent that sees only
 * the turn's changes and the project's files, reads them for bugs that have not shown yet, and changes nothing. What it
 * finds goes back to the working agent before the tester tries the result.
 */

export const REVIEW_STEPS = 25;
/** The diff it is given, at most: the rest it reads from the files. */
const DIFF_LIMIT = 60_000;

export interface ReviewIssue {
  file: string;
  what: string;
  severity: "bug" | "risk" | "minor";
}

export interface ReviewResult {
  issues: ReviewIssue[];
  summary: string;
}

export interface ReviewDeps {
  conn: Connection;
  model: string;
  price: ModelInfo | undefined;
  folder: string;
  signal: AbortSignal;
  idleTimeoutMs: number;
  budgetUsd: number;
  hooks: Omit<ToolHooks, "onFinish">;
  onSpend(usd: number, tokens: { inputTokens: number; outputTokens: number; cachedTokens: number }): void;
  onText(text: string): void;
}

const SYSTEM = (folder: string) =>
  [
    `You are the code reviewer of a coding agent's work in ${folder}. You get the diff of what it changed in this turn.`,
    "Read the changes, and the files around them when needed, for real bugs: wrong logic, a case not handled, data lost or",
    "leaked, a security hole, a broken contract between parts, a test weakened to pass. Not style, not taste, not what",
    "works. You change nothing and run nothing that changes anything.",
    "Call report_review once at the end with each bug: the file, what is wrong and why, how it shows; nothing found is",
    "a fine result. Be concise. Write in the language of the user's request.",
  ].join("\n");

/** The review of the turn's changes; null when it could not finish. */
export async function reviewCode(d: ReviewDeps, job: { asked: string; diff: string }): Promise<ReviewResult | null> {
  let result: ReviewResult | null = null;
  const diff = job.diff.length > DIFF_LIMIT ? `${job.diff.slice(0, DIFF_LIMIT)}\n… the diff goes on; read the rest from the files.` : job.diff;
  const messages: ModelMessage[] = [{ role: "user", content: `What the user asked for:\n${job.asked}\n\nThe changes of this turn:\n${diff}\n\nReview them now.` }];
  const report = tool({
    description: "Report the review: the bugs found in the changes (none is fine), and one line of summary.",
    inputSchema: z.object({
      issues: z.array(z.object({ file: z.string(), what: z.string(), severity: z.enum(["bug", "risk", "minor"]) })).max(30),
      summary: z.string(),
    }),
    execute: async (r) => {
      result = r;
      return "Reported.";
    },
  });
  await runAgent({
    conn: d.conn,
    model: d.model,
    price: d.price,
    worktree: d.folder,
    messages,
    mode: "review",
    extraTools: { report_review: report },
    stopTools: ["report_review"],
    noFinish: true,
    prune: true,
    maxSteps: REVIEW_STEPS,
    system: SYSTEM(d.folder),
    spentUsd: 0,
    budgetUsd: d.budgetUsd,
    signal: d.signal,
    idleTimeoutMs: d.idleTimeoutMs,
    hooks: d.hooks,
    onText: d.onText,
    onStep: (step) => {
      messages.push(...step.messages);
      d.onSpend(step.costUsd, { inputTokens: step.inputTokens, outputTokens: step.outputTokens, cachedTokens: step.cachedTokens ?? 0 });
    },
  }).catch(() => null);
  return result;
}

/** The reviewer's findings, as the next message of the working agent's conversation. */
export function reviewMessage(r: ReviewResult): string {
  const lines = r.issues.map((x, i) => `${i + 1}. [${x.severity}] ${x.file}: ${x.what}`);
  return [`[Drimvox's code reviewer read your changes and found:]`, ...lines, "", "Fix what is real; say in one line why for what is not. The tester tries the result after."].join("\n");
}
