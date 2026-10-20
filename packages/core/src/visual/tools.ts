import { MAX_WAIT_MS, type PageAction, type TaskEvent, type VisualCheck } from "@artel/shared";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Background } from "../agent/background";
import { classifyCommand } from "../agent/commands";
import type { ToolHooks } from "../agent/tools";
import { askAboutPicture, mayLookAt, type Screenshotter, type Shots, type Vision } from "./look";

/** What looking at pages needs from the core. */
export interface VisualKit {
  background: Background;
  /** Null where nothing can take screenshots (tests without one, a server without a browser). */
  screenshot: Screenshotter | null;
  shots: Shots;
}

export interface VisualDeps {
  kit: VisualKit;
  taskId: string;
  worktree: string;
  /** Null when no model that sees pictures is available: then there is no look_at_page. */
  vision: Vision | null;
  hooks: Omit<ToolHooks, "onFinish">;
  onSpend(usd: number): void;
  event(kind: TaskEvent["kind"], data: unknown): void;
}

const SIZE = { width: 1280, height: 800 };
/** A window of this width, as tall as a desktop or a phone screen. */
const sizeOf = (width?: number) => (width ? { width, height: width < 768 ? 844 : 800 } : SIZE);
/** Looks per turn: enough to check a page and its fix; the polish comes from Artel's design review. */
export const MAX_LOOKS = 4;
const CODER_LIMIT = `Finish with what you have: Artel's design review looks at the screens after acceptance and sends concrete notes.`;

/** Who looks: the coder by default; the acceptance agent checks every requirement and gets more looks. */
export interface LookLimit {
  looks: number;
  /** What the agent is told when it is out of looks. */
  then: string;
}

export const VISUAL_HINT =
  "To see an interface you built, start it with start_background (for example npm run dev), read its output with " +
  "read_background to learn the address, then call look_at_page with the address and a question about what should be visible.";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** Takes a screenshot, keeps it and asks the vision model; the answer is what the agent or the gate gets. */
async function look(d: VisualDeps, url: string, question: string, signal?: AbortSignal, width?: number, steps?: PageAction[]): Promise<{ shot: string; answer: string }> {
  if (!d.kit.screenshot || !d.vision) throw new Error("No way to look at pages here");
  const png = await d.kit.screenshot(url, sizeOf(width), steps?.length ? steps : undefined);
  const shot = d.kit.shots.save(png);
  d.event("screenshot", { id: shot, url });
  const { text, costUsd } = await askAboutPicture(d.vision, png, question, signal);
  d.onSpend(costUsd);
  return { shot, answer: text };
}

export function visualTools(d: VisualDeps, limit: LookLimit = { looks: MAX_LOOKS, then: CODER_LIMIT }): ToolSet {
  const run = async (callId: string, name: string, input: unknown, work: () => Promise<string>) => {
    d.hooks.onCall({ callId, name, input });
    let ok = true;
    let output: string;
    try {
      output = await work();
    } catch (err) {
      ok = false;
      output = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    d.hooks.onResult({ callId, name, ok, output: output.slice(0, 4000) });
    return output;
  };
  type Options = { toolCallId: string; abortSignal?: AbortSignal };

  const tools: ToolSet = {
    start_background: tool({
      description: "Start a long-running command in the project folder, such as a dev server. Returns its number and first output.",
      inputSchema: z.object({ command: z.string().min(1).max(1000) }),
      execute: ({ command }, o: Options) =>
        run(o.toolCallId, "start_background", { command }, async () => {
          const verdict = classifyCommand(command, d.worktree);
          if (verdict.action === "ask" && !(await d.hooks.askApproval(command, verdict.reason, o.abortSignal))) {
            throw new Error("The user denied this command.");
          }
          const p = d.kit.background.start(d.taskId, command, d.worktree);
          await sleep(3000, o.abortSignal);
          return `Started process ${p.id} (pid ${p.child.pid}).\n${d.kit.background.read(d.taskId, p.id)}`;
        }),
    }),
    read_background: tool({
      description: "Read the latest output of a background process.",
      inputSchema: z.object({ id: z.number().int().min(1) }),
      execute: ({ id }, o: Options) => run(o.toolCallId, "read_background", { id }, async () => d.kit.background.read(d.taskId, id)),
    }),
    stop_background: tool({
      description: "Stop a background process. All of them stop by themselves when the task's turn ends.",
      inputSchema: z.object({ id: z.number().int().min(1) }),
      execute: ({ id }, o: Options) =>
        run(o.toolCallId, "stop_background", { id }, async () => (d.kit.background.stop(d.taskId, id) ? `Stopped process ${id}.` : `No process ${id}.`)),
    }),
  };
  if (!d.kit.screenshot || !d.vision) return tools;

  let looks = 0;
  tools.look_at_page = tool({
    description:
      "Open a page in a browser, take a screenshot and ask a model that sees pictures about it. The window is 1280 px wide; give a width such as 390 to see the phone layout. " +
      "To check a scenario as a person would, give steps done before the screenshot: click a button or link by its text, type into a field by its label or placeholder, press a key, wait.",
    inputSchema: z.object({
      url: z.string().min(1).max(2000),
      question: z.string().min(1).max(2000),
      width: z.number().int().min(320).max(1920).optional().describe("Window width in pixels; 390 is a phone"),
      steps: z
        .array(
          z.object({
            action: z.enum(["click", "type", "press", "wait"]),
            target: z.string().min(1).max(300).optional().describe("Visible text, label, placeholder or CSS selector"),
            text: z.string().max(2000).optional().describe("What to type, or the key to press"),
            ms: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
          }),
        )
        .max(20)
        .optional()
        .describe("A scenario done in order before the screenshot"),
    }),
    execute: ({ url, question, width, steps }, o: Options) =>
      run(o.toolCallId, "look_at_page", { url, question, width, steps }, async () => {
        if (!mayLookAt(url)) throw new Error("Only this computer (localhost) and public addresses can be opened");
        if (++looks > limit.looks) throw new Error(`You have looked at pages ${limit.looks} times in this turn. ${limit.then}`);
        return (await look(d, url, question, o.abortSignal, width, steps)).answer;
      }),
  });
  return tools;
}

export interface VisualResult {
  check: VisualCheck;
  ok: boolean;
  answer: string;
}

/** Artel's own look at the pages from the spec: start the app if asked, wait for the address, judge the screenshot. */
export async function runVisualChecks(d: VisualDeps, checks: VisualCheck[], signal?: AbortSignal): Promise<VisualResult[]> {
  const results: VisualResult[] = [];
  const started: number[] = [];
  try {
    for (const check of checks) {
      if (check.start) started.push(d.kit.background.start(d.taskId, check.start, d.worktree).id);
      let answer: string;
      let ok = false;
      if (!mayLookAt(check.url)) answer = "Only this computer (localhost) and public addresses can be opened.";
      // A server Artel just started needs time to come up; one that already runs is photographed at once.
      else if (check.start && !(await reachable(check.url, signal))) answer = `${check.url} did not answer within a minute.`;
      else {
        // Seen live: one page passed and failed by turns over a language switch the screenshot did not show.
        const question = [
          `Does the page meet this, in substance: "${check.expect}"?`,
          "FAIL only when something important is missing or broken: an error, an empty or half-drawn page, a missing part.",
          "Wording that differs a little, and what a still screenshot cannot show (motion, sound, hover, what opens on a click),",
          "are no reasons to fail. Start the answer with PASS or FAIL, then say what you see.",
        ].join(" ");
        answer = (await look(d, check.url, question, signal)).answer;
        ok = /^\W*PASS\b/i.test(answer);
      }
      d.event("check", { phase: "visual", command: `${check.url} — ${check.expect}`, exitCode: ok ? 0 : 1, ok, output: answer });
      results.push({ check, ok, answer });
    }
  } finally {
    for (const id of started) d.kit.background.stop(d.taskId, id);
  }
  return results;
}

/** A freshly started dev server takes a while; any answer from the address counts. */
export async function reachable(url: string, signal?: AbortSignal): Promise<boolean> {
  for (let i = 0; i < 60 && !signal?.aborted; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(3000) });
      return true;
    } catch {
      await sleep(1000, signal);
    }
  }
  return false;
}
