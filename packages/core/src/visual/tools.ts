import type { PageAction } from "@drimvox/shared";
import { pageStepsInput } from "./steps";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Background } from "../agent/background";
import { classifyCommand, DENIED } from "../agent/commands";
import type { ToolHooks } from "../agent/tools";
import { askAboutPicture, askAboutPictures, mayLookAt, type Screenshotter, type Shots, type Vision } from "./look";

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
  /** A screenshot taken: its id among the shots, and the page. */
  event(kind: "screenshot", data: { id: string; url: string }): void;
  /**
   * The agent's own model sees pictures: the screenshots go into its conversation and it looks itself, with all it knows
   * of the task, instead of reading another request's words about them (asked for: DeepSeek sees, why another look).
   */
  show?(pictures: Buffer[], caption: string): void;
}

/** What the agent is told when the screenshots are in its conversation. */
const SHOWN = "The screenshot follows in the conversation: look at it yourself.";

const SIZE = { width: 1280, height: 800 };
/** A window of this width, as tall as a desktop or a phone screen. */
const sizeOf = (width?: number) => (width ? { width, height: width < 768 ? 844 : 800 } : SIZE);
/** Looks per turn: enough to check a page and its fix; the polish comes from Drimvox's design review. */
export const MAX_LOOKS = 4;
/** check_page calls per answer: once, and once more after the fixes. */
export const MAX_CHECKS = 2;
const CODER_LIMIT = `Finish with what you have: Drimvox's design review looks at the screens after acceptance and sends concrete notes.`;

/** Who looks: the coder by default; the acceptance agent checks every requirement and gets more looks. */
export interface LookLimit {
  looks: number;
  /** What the agent is told when it is out of looks. */
  then: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** Takes a screenshot, keeps it and asks the vision model; the answer is what the agent or the gate gets. */
async function look(d: VisualDeps, url: string, question: string, signal?: AbortSignal, width?: number, steps?: PageAction[]): Promise<{ shot: string; answer: string }> {
  if (!d.kit.screenshot || !d.vision) throw new Error("No way to look at pages here");
  const taken = await d.kit.screenshot(url, sizeOf(width), steps?.length ? steps : undefined);
  const png = Buffer.isBuffer(taken) ? taken : taken.png;
  const errors = Buffer.isBuffer(taken) ? [] : taken.console;
  const shot = d.kit.shots.save(png);
  d.event("screenshot", { id: shot, url });
  let text = SHOWN;
  if (d.show) d.show([png], `${url}${width ? ` at ${width} px` : ""}: ${question}`);
  else {
    const said = await askAboutPicture(d.vision, png, question, signal);
    d.onSpend(said.costUsd);
    text = said.text;
  }
  // What the picture cannot show: a script that failed, a file that did not load.
  return { shot, answer: errors.length ? `${text}\n\nErrors in the page's console:\n${errors.map((e) => `- ${e}`).join("\n")}` : text };
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
      description:
        "Start a command that keeps running in the project folder: a dev server, a watcher. Not for builds, tests, installs " +
        "or quick commands: run those with run_command (it waits up to 600 seconds and gives the output at once). " +
        "Returns its number and first output. What you " +
        "started stays running between the user's messages; the same command already running is not started again.",
      inputSchema: z.object({ command: z.string().min(1).max(1000) }),
      execute: ({ command }, o: Options) =>
        run(o.toolCallId, "start_background", { command }, async () => {
          const verdict = classifyCommand(command, d.worktree);
          if (verdict.action === "deny") throw new Error(DENIED[verdict.reason]);
          if (verdict.action === "ask" && !(await d.hooks.askApproval(command, verdict.reason, o.abortSignal))) {
            throw new Error("The user denied this command.");
          }
          const already = d.kit.background.runningAs(d.taskId, command);
          if (already) return `Not started: this command is already running as process ${already.id}. Use it (read_background ${already.id}), or stop it first with stop_background.
${d.kit.background.read(d.taskId, already.id)}`;
          // What else of this agent still runs (seen live: a second server on the port of the first, under another command).
          const others = d.kit.background.running().filter((r) => r.key === d.taskId);
          const p = d.kit.background.start(d.taskId, command, d.worktree);
          await sleep(3000, o.abortSignal);
          const also = others.length ? `\nAlso running from before: ${others.map((r) => `process ${r.id}: ${r.command}`).join("; ")}. Stop one that holds the same port.` : "";
          return `Started process ${p.id} (pid ${p.child.pid}).${also}\n${d.kit.background.read(d.taskId, p.id)}`;
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
      steps: pageStepsInput.describe("A scenario done in order before the screenshot"),
    }),
    execute: ({ url, question, width, steps }, o: Options) =>
      run(o.toolCallId, "look_at_page", { url, question, width, steps }, async () => {
        if (!mayLookAt(url)) throw new Error("Only this computer (localhost) and public addresses can be opened");
        if (++looks > limit.looks) throw new Error(`You have looked at pages ${limit.looks} times in this turn. ${limit.then}`);
        return (await look(d, url, question, o.abortSignal, width, steps)).answer;
      }),
  });
  let checks = 0;
  // Seen live: a weather site was checked with 8 openings, 13 looks and 29 scripts in the page, each a request to the model.
  tools.check_page = tool({
    description:
      "Check a page once it is built, in one call: Drimvox opens it at a desktop width (1280) and a phone width (390), a model " +
      "that sees pictures looks at both, and you get what is broken or looks wrong on each, with the errors of the page's " +
      "console. Use it instead of opening the page and looking at it step by step.",
    inputSchema: z.object({
      url: z.string().min(1).max(2000),
      focus: z.string().max(1000).optional().describe("What to look at closely, such as the part you just changed"),
    }),
    execute: ({ url, focus }, o: Options) =>
      run(o.toolCallId, "check_page", { url, focus }, async () => {
        if (!mayLookAt(url)) throw new Error("Only this computer (localhost) and public addresses can be opened");
        // Seen live: told to check twice at most, the agent checked five times, tweaking details between.
        if (++checks > MAX_CHECKS) throw new Error(`You have checked pages ${MAX_CHECKS} times in this answer: that is enough. Stop and give the user your short reply.`);
        if (++looks > limit.looks) throw new Error(`You have looked at pages ${limit.looks} times in this turn. ${limit.then}`);
        const taken = [];
        for (const width of [1280, 390]) taken.push(await d.kit.screenshot!(url, sizeOf(width)));
        const errors = [...new Set(taken.flatMap((t) => (Buffer.isBuffer(t) ? [] : t.console)))];
        const pictures = taken.map((t) => {
          const png = Buffer.isBuffer(t) ? t : t.png;
          d.event("screenshot", { id: d.kit.shots.save(png), url });
          return { data: png, mediaType: "image/png" };
        });
        const consoleErrors = errors.length ? `\n\nErrors in the page's console:\n${errors.map((e) => `- ${e}`).join("\n")}` : "";
        if (d.show) {
          d.show(
            pictures.map((p) => p.data),
            `${url} at a desktop width (1280) and a phone width (390)${focus ? `; look closely at: ${focus}` : ""}`,
          );
          return `The two screenshots, desktop then phone, follow in the conversation: look at them yourself.${consoleErrors}`;
        }
        const { text, costUsd } = await askAboutPictures(
          d.vision!,
          pictures,
          [
            "These are screenshots of one page: the first at a desktop width, the second at a phone width.",
            "Say briefly, for each, what is broken or looks wrong: overlapping or cut text, parts out of the screen, empty or",
            "half-drawn areas, unreadable contrast, a layout that falls apart. When it all looks right, say so in one line.",
            focus ? `Look closely at: ${focus}.` : "",
            "Answer in the language of this request's focus when it has one, else in English.",
          ]
            .filter(Boolean)
            .join(" "),
          o.abortSignal,
        );
        d.onSpend(costUsd);
        return errors.length ? `${text}\n\nErrors in the page's console:\n${errors.map((e) => `- ${e}`).join("\n")}` : text;
      }),
  });
  return tools;
}
