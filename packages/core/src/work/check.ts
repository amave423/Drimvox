import type { ModelInfo } from "@drimvox/shared";
import { scratchOf } from "./agent-prompt";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { runAgent } from "../agent/run";
import type { ToolHooks } from "../agent/tools";
import type { Connection } from "../providers/repo";

/** Steps the tester may take: enough to start the result and go through what was asked, not to wander. */
export const CHECK_STEPS = 60;
/** Steps before the end at which the tester is told to wrap up. */
const WRAP_UP = 8;
/** Rounds of "found, fixed, checked again" in one turn: past them the user decides. */
export const CHECK_ROUNDS = 2;

export interface Problem {
  what: string;
  /** How the tester got there, step by step, so the agent can do the same. */
  steps: string;
  severity: "broken" | "wrong" | "minor";
}

export interface CheckResult {
  problems: Problem[];
  /** What it tried, in a few lines, for the user. */
  summary: string;
  /** How it started the project to try it: kept for the next tester (asked for: half its steps went on finding that). */
  start?: string;
}

export interface CheckDeps {
  conn: Connection;
  model: string;
  price: ModelInfo | undefined;
  /** What it may spend: the run's allowance past its limit (seen live: a tester went $0.10 past a $0.15 budget). */
  budgetUsd?: number;
  folder: string;
  signal: AbortSignal;
  idleTimeoutMs: number;
  /** Its hands and eyes: the background processes, the browser, screenshots, the comparison with a design. */
  tools: ToolSet;
  /** The screenshots for its own eyes when its model sees (visual/tools.ts `show`), once each. */
  pictures?: () => { pictures: Buffer[]; caption: string } | null;
  hooks: Omit<ToolHooks, "onFinish">;
  onSpend(usd: number, tokens: { inputTokens: number; outputTokens: number; cachedTokens: number }): void;
  /** Words it says on the way, for the feed. */
  onText(text: string): void;
}

const SYSTEM = (folder: string) =>
  [
    `You are the tester of a coding agent's work in ${folder}. The agent says it is done; the user has not tried it yet.`,
    "Try it as the user will, before them: start what was made the way the user starts it, and go through what they asked",
    "for, click by click, as a person would. You do not change the project's files: you only run, open, look and report.",
    "",
    "# How to test",
    "- Start the real thing: the dev server or the built app, as the project's notes and README say. Use start_background",
    "  for servers, run_command for the rest. Stop what you started before you report: by its process id, never by the",
    "  program's name (Drimvox itself may run as electron.exe).",
    "- Go through each thing the user asked for in this turn, one by one from the user's own words, not from what the agent",
    "  says it did; and the flows around it that it may have broken. Use the browser tools to click, type and read; look",
    "  at the screens yourself (look_at_page, check_page). A desktop app is tried in its real window too, not only as a page.",
    "- Do what people do around a change: close the app and open it again, delete what was made, open a picture full",
    "  screen, make the window small and large, switch away and back.",
    "- Look closely at small things: photograph icons, status dots, checkboxes and fields up close, enlarged, next to the",
    "  same ones in the design; jagged or cut-off edges, misaligned boxes and clipped parts count.",
    "- A design or mockup in the project (a picture, an HTML page) is the reference: compare the screens with it",
    "  (page_match_design, the mockup's page served locally by address), and the effects only its code shows (hover,",
    "  transitions, effects that follow the cursor).",
    "- Sound and video: send a known signal through the real path and check what arrives (its level, no clicks or gaps),",
    "  not only that bytes flow. Chromium plays a WAV file as the microphone with --use-file-for-fake-audio-capture=<path>",
    "  (the full path, written as a Windows path on Windows).",
    "- Two people where it takes two: two browser contexts, two accounts. Someone without the right must be refused.",
    `- Scripts of your own (a Playwright run, a probe, screenshots) go in ${scratchOf(folder)}, never in the project.`,
    "- Test on this computer: a local server with a temporary database, never the user's live server and its accounts.",
    "",
    "# What to report",
    "A release or a deploy the user asked for waits for your clean check (Drimvox holds it until then): that it is not out",
    "yet is not a problem to report. Report on the work itself.",
    "Call report_check once at the end. Report only what you saw happen yourself, each with the steps to see it again;",
    "not guesses from reading code, not taste. When the user listed points, say for each whether it works as asked. Nothing",
    "found is a fine result: then say what you tried. Be concise.",
    "Write your words and the report in the language of the user's request.",
  ].join("\n");

/**
 * The tester (asked for: "the agent says done, and I find the bugs"): a second agent with a fresh context and one job,
 * to try the result as the user will and find what is broken. Its report goes back to the working agent to fix.
 */
export async function checkWork(
  d: CheckDeps,
  job: { asked: string; said: string; notes: string; tests?: string; recipe?: string; screens?: string[]; packaged?: string | null },
): Promise<CheckResult | null> {
  let result: CheckResult | null = null;
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        `What the user asked for in this turn:\n${job.asked}`,
        `What the agent says it did:\n${job.said || "(nothing said)"}`,
        job.tests ?? "",
        job.screens?.length ? `Interface files changed in this turn: ${job.screens.join(", ")}. Look at the screens they draw, up close.` : "",
        job.recipe ? `How the last tester started this project to try it (use it; fix it if it no longer works):\n${job.recipe}` : "",
        job.packaged ?? "",
        job.notes ? `The project's notes (how to build, run and deploy; what the user wants and does not):\n${job.notes}` : "",
        "Test it now.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
  const report = tool({
    description: "Give your findings and end. Only what you saw happen, each with the steps to see it again.",
    inputSchema: z.object({
      problems: z
        .array(
          z.object({
            what: z.string().min(1).max(1000),
            steps: z.string().min(1).max(2000),
            severity: z.enum(["broken", "wrong", "minor"]).describe("broken: does not work; wrong: works, not as asked; minor: small"),
          }),
        )
        .max(30),
      summary: z.string().min(1).max(2000).describe("What you tried, in a few lines"),
      start: z.string().max(2000).optional().describe("The commands and steps that started the project for trying it, for the next tester"),
    }),
    execute: async (r) => {
      result = r;
      return "Reported.";
    },
  });
  let steps = 0;
  const pass = (only?: string, maxSteps = CHECK_STEPS) =>
    runAgent({
      conn: d.conn,
      model: d.model,
      price: d.price,
      worktree: d.folder,
      messages,
      mode: "review",
      extraTools: { report_check: report },
      ownTools: only ? undefined : d.tools,
      stopTools: ["report_check"],
      noFinish: true,
      prune: true,
      maxSteps,
      ...(only ? { only } : {}),
      pictures: d.pictures,
      // Near the end, a word to wrap up (seen live: 61 steps of real testing, and no report: all of it lost).
      remind: () => (steps >= CHECK_STEPS - WRAP_UP ? `${CHECK_STEPS - steps} steps left: stop what you are trying and call report_check with what you saw.` : null),
      system: SYSTEM(d.folder),
      spentUsd: 0,
      budgetUsd: d.budgetUsd ?? Number.POSITIVE_INFINITY,
      signal: d.signal,
      idleTimeoutMs: d.idleTimeoutMs,
      hooks: d.hooks,
      onText: d.onText,
      onStep: (step) => {
        steps++;
        messages.push(...step.messages);
        d.onSpend(step.costUsd, { inputTokens: step.inputTokens, outputTokens: step.outputTokens, cachedTokens: step.cachedTokens ?? 0 });
      },
    }).catch(() => null);
  await pass();
  // Out of steps without a report: one more step that can only give it.
  if (!result && !d.signal.aborted) {
    messages.push({ role: "user", content: "You are out of steps. Call report_check now with what you saw, problems found so far included." });
    await pass("report_check", 1);
  }
  return result;
}

/** The tester's findings, as the next message of the working agent's conversation. */
export function findingsMessage(r: CheckResult): string {
  const lines = r.problems.map((p, i) => `${i + 1}. [${p.severity}] ${p.what}\n   How to see it: ${p.steps}`);
  return [
    "[Drimvox's tester tried your work as the user will, and found:]",
    ...lines,
    "",
    "Reproduce each, fix it, check that same case again, and reply about each.",
  ].join("\n");
}
