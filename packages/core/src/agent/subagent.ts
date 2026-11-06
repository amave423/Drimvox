import type { ModelInfo } from "@drimvox/shared";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import type { Connection } from "../providers/repo";
import { runAgent } from "./run";

/** Steps a sub-agent may take: enough to find and read what it was sent for, not to wander. */
const SUBAGENT_STEPS = 30;
/** The longest report the main agent gets back. */
const REPORT_LIMIT = 8_000;

export interface SubagentDeps {
  conn: Connection;
  model: string;
  price: ModelInfo | undefined;
  folder: string;
  signal: AbortSignal;
  idleTimeoutMs: number;
  /** Tools of its own besides reading the folder (the internet), quiet in the main feed. */
  tools?: () => ToolSet;
  /** What it spent, in money and in tokens, for the answer's own count. */
  onSpend(usd: number, tokens: { inputTokens: number; outputTokens: number }): void;
  /** One line in the main feed for the whole sub-agent, as Claude Code shows its Task. */
  onCall(name: string, what: string): void;
}

const SYSTEM = (folder: string) =>
  [
    `You are a sub-agent of a coding agent working in ${folder}. You get one self-contained job: find, read and work out`,
    "what it asks, in the project's files (list_files, read_file, search) and, when you have them, on the web. You never",
    "change anything. You do not see the main agent's conversation: the job says everything you have.",
    "Be quick: read what answers the job, not the whole project. When you know, call report with what the main agent",
    "needs and nothing more: the answer, the files and lines it is in, short excerpts of code where they matter, and what",
    "you could not find. Plain text, at most about 600 words.",
  ].join("\n");

/**
 * Sub-agents, as Claude Code's Task (asked for): the main agent hands a piece of research to an agent with a fresh,
 * empty context, and gets back only its report. What the sub-agent read stays out of the main conversation, which every
 * step sends again: the main context stays small, and the work costs less on long tasks.
 */
export function subagentTools(d: SubagentDeps): ToolSet {
  return {
    delegate: tool({
      description:
        "Hand a self-contained piece of research to a sub-agent with a fresh, empty context: where something is in the code, " +
        "how a part of the project works (reading many files), how a library or an API is used (the web). It reads and " +
        "searches, never edits, and you get back only its short report, so your own context stays small. Prefer it to " +
        "reading many files yourself. It does not see this conversation: put everything it needs in the prompt. Several " +
        "can run in one step.",
      inputSchema: z.object({
        description: z.string().min(1).max(80).describe("3-8 words: what it is for, shown to the user"),
        prompt: z.string().min(1).max(8_000).describe("The whole job, with what to find and what to report"),
      }),
      execute: async ({ description, prompt }) => {
        d.onCall("delegate", description);
        let report: string | null = null;
        let said = "";
        const messages: ModelMessage[] = [{ role: "user", content: prompt }];
        const quiet = { onCall: () => {}, onResult: () => {}, askApproval: async () => false as const };
        const outcome = await runAgent({
          conn: d.conn,
          model: d.model,
          price: d.price,
          worktree: d.folder,
          messages,
          mode: "read",
          extraTools: {
            report: tool({
              description: "Give your report to the main agent and end.",
              inputSchema: z.object({ report: z.string().min(1).max(REPORT_LIMIT * 2) }),
              execute: async ({ report: r }) => {
                report = r;
                return "Reported.";
              },
            }),
          },
          ownTools: d.tools?.(),
          stopTools: ["report"],
          noFinish: true,
          maxSteps: SUBAGENT_STEPS,
          system: SYSTEM(d.folder),
          spentUsd: 0,
          budgetUsd: Number.POSITIVE_INFINITY,
          signal: d.signal,
          idleTimeoutMs: d.idleTimeoutMs,
          hooks: quiet,
          onText: (text) => (said = said ? `${said}\n\n${text}` : text),
          onStep: (step) => {
            messages.push(...step.messages);
            d.onSpend(step.costUsd, { inputTokens: step.inputTokens, outputTokens: step.outputTokens });
          },
        }).catch(() => ({ kind: "error" as const }));
        const given = (report as string | null) ?? said.trim();
        if (given) return given.slice(0, REPORT_LIMIT);
        return outcome.kind === "stopped" ? "Stopped." : "The sub-agent ended without a report. Do this part yourself.";
      },
    }),
  };
}
