import type { ModelInfo, ProviderError, ThinkingLevel } from "@drimvox/shared";
import type { ServiceModel } from "./service-model";
import { hasToolCall, isStepCount, streamText, type ModelMessage, type StopCondition, type ToolSet } from "ai";
import { describeError } from "../providers/errors";
import { billedUsd, costOf, usageOf } from "../providers/pricing";
import { usdRub } from "../rates";
import { languageModel } from "../providers/model";
import { isLocal, NO_LIMIT_MS } from "../budget";
import type { Connection } from "../providers/repo";
import { systemPrompt } from "./prompt";
import { buildTools, type ToolHooks } from "./tools";
import { codeTool } from "./code-mode";
import { memoryLimit, sizeOf, PRUNE_CACHED, TRIM_SHARE } from "./memory";
import { notesBlock } from "./notes";
import { compactHistory, KEEP_WHOLE } from "../work/compact";
import { answeredOnly, repairToolJson } from "./repair";
import { CHUNK, PROTECT, pruneOutputs } from "./prune";
import { traceStep, traceUsage } from "./trace";
import { deferTools } from "./deferred";
import { learnFromAnswer } from "../providers/availability";
import { thinkingOptions } from "../chats/thinking";
import { Workspace } from "./workspace";

export const MAX_STEPS = 60;

/** Rounds a pass may go on for after the provider cut an answer by its output limit. */
const MAX_CUTS = 3;
// Seen in a manual test: after a cut GLM said "I write in parts" and wrote three files in one step again, cut again.
const CUT_NOTE =
  "Your last message was cut off by the output limit (your thinking counts toward it too), and nothing in its unfinished " +
  "part was done. Go on from there, thinking briefly. Write one file per step, at most about 200 lines in one write_file; " +
  "then add the rest with edit_file, appending after its last lines.";

export interface RunInput {
  conn: Connection;
  model: string;
  /** The project's own model for the summaries of a long history, when it chose one. */
  service?: ServiceModel | null;
  price: ModelInfo | undefined;
  worktree: string;
  /** Conversation so far, ending with the new user message. */
  messages: ModelMessage[];
  /** "read" for the interview and the spec: no edits, no commands; "review" for the acceptance agent: commands, no edits. */
  mode: "read" | "review" | "write";
  /** Tools of the current step, such as ask_questions or propose_spec. */
  extraTools?: ToolSet;
  /** Tools that report their calls to the feed themselves (internet, skills, pictures); passed as they are. */
  ownTools?: ToolSet;
  /** Calling any of these ends the pass, like finish does. */
  stopTools?: string[];
  /** No finish tool: a project's run ends with its own (docs/specs/project-work.md). */
  noFinish?: boolean;
  /** Asked after every step: true ends the pass there (a message from the user waits, the budget changed). */
  stopWhen?: () => boolean;
  /** Asked before every step: a reminder that goes with that request only, such as ticking off the checklist. */
  remind?: () => string | null;
  /** The latest screenshots the agent took, for its own model to look at (visual/tools.ts `show`): with every step after. */
  pictures?: () => { pictures: Buffer[]; caption: string } | null;
  /** Old tool outputs leave the conversation as OpenCode prunes them (prune.ts): a project's run. */
  prune?: boolean;
  /** More tools kept out of every step until the model loads them, such as the user's MCP servers' (deferred.ts). */
  rare?: string[];
  /** Steps this pass may take; MAX_STEPS when not given. */
  maxSteps?: number;
  /** The one tool the model may and must call now, such as the acceptance verdict once looking is over. */
  only?: string;
  /** The current step's instructions, added to the system prompt. */
  instructions?: string;
  /** A system prompt of its own instead of the coding agent's, for agents that do not code (acceptance). */
  system?: string;
  /** false: the model answers without thinking where the provider lets us turn it off (DeepSeek). */
  thinking?: boolean;
  /** How much the model thinks, as the user picked it (a project's box); unset or "auto": as the provider decides. */
  thinkingLevel?: ThinkingLevel | null;
  /** Money already spent on the task and the limit for it. */
  spentUsd: number;
  budgetUsd: number;
  signal: AbortSignal;
  idleTimeoutMs: number;
  hooks: Omit<ToolHooks, "onFinish">;
  onText(text: string): void;
  /** After every finished step: the messages it produced and its usage. */
  onStep(step: { messages: ModelMessage[]; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; priced: boolean }): void;
}

/** On "auto" thinking, every this many steps the model thinks fully again, to look at the plan anew. */
const THINK_AGAIN_EVERY = 10;

export type RunOutcome =
  | { kind: "finished"; summary: string; commitMessage: string | null }
  | { kind: "budget" }
  | { kind: "steps" }
  | { kind: "stopped" }
  | { kind: "error"; error: ProviderError };

/** One pass of the agent loop: model and tools until finish, a limit, Stop or an error. */
export async function runAgent(i: RunInput): Promise<RunOutcome> {
  let finished: { summary: string; commitMessage: string } | null = null;
  let error: ProviderError | null = null;
  let lastText = "";
  let spent = i.spentUsd;
  let steps = 0;
  /** The provider served part of a request from its cache: the history is then kept as it is (see prepareStep). */
  let cacheSeen = false;

  // The provider's own bill when it sends one (in rubles for RouterAI), else the catalog's prices.
  const usdPerUnit = i.conn.currency === "RUB" ? 1 / (await usdRub()) : 1;
  const stepCost = (step: { usage: Parameters<typeof usageOf>[0]; providerMetadata?: unknown }) =>
    billedUsd(step.providerMetadata, usdPerUnit) ?? costOf(i.price, i.conn.preset, usageOf(step.usage)) ?? 0;

  // A model that sends nothing for too long is treated like a provider error. While a tool runs (a long command,
  // a question to the user) the model is not the one keeping quiet: the clock stands still until the last tool ends.
  const silence = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = 0;
  const resetClock = () => {
    clearTimeout(timer);
    if (running === 0) timer = setTimeout(() => silence.abort(), isLocal(i.conn) ? NO_LIMIT_MS : i.idleTimeoutMs);
  };

  // Calls our own tools reported; the rest are the SDK's rejections.
  const reported = new Set<string>();
  const hooks: ToolHooks = {
    ...i.hooks,
    onCall: (call) => {
      reported.add(call.callId);
      i.hooks.onCall(call);
    },
    onFinish: (result: { summary: string; commitMessage: string }) => (finished = result),
  };
  const { finish: finishTool, ...base } = buildTools(new Workspace(i.worktree), hooks, i.mode, i.extraTools);
  const clock = {
    start: () => {
      running++;
      clearTimeout(timer);
    },
    end: () => {
      running--;
      resetClock();
    },
  };
  const tools = paused({ ...base, ...(i.noFinish || !finishTool ? {} : { finish: finishTool }), ...i.ownTools }, clock);

  // Many actions in one step: JavaScript that calls the other tools (asked for: as OpenCode's Code Mode).
  if (!i.only) Object.assign(tools, paused({ execute: codeTool(() => tools, ["finish", ...(i.stopTools ?? [])]) }, clock));

  // The rare tools wait until the model loads them (deferred.ts); a step with one tool to call keeps just that one.
  const deferral = i.only ? null : deferTools(tools, i.rare);

  // The project's notes (AGENTS.md) start every request, read once a pass (measured: the agent's update of its notes
  // changed the start of the next request, and the whole conversation went at full price, 50 times the cached one); the
  // update shows from the next pass.
  const notes = notesBlock(i.worktree);
  const system = () => [i.system ?? systemPrompt(i.worktree), i.system ? "" : i.instructions, notes].filter(Boolean).join("\n\n");

  // A round cut by the provider's output limit goes on from what it said and did (seen live: "Now I write the styles…",
  // and the answer ended there, counted as done, the file never written).
  const start = answeredOnly([...i.messages]);
  const said: ModelMessage[] = [];
  let cut = false;
  for (let round = 0; round <= MAX_CUTS; round++) {
    if (round > 0 && (!cut || finished || error || i.signal.aborted || silence.signal.aborted)) break;
    if (round > 0 && (spent >= i.budgetUsd || steps >= (i.maxSteps ?? MAX_STEPS) || i.stopWhen?.())) break;
    const messages: ModelMessage[] = round === 0 ? start : answeredOnly([...start, ...said, { role: "user", content: CUT_NOTE }]);
    const stepsBefore = steps;
    const spentBefore = spent;
    const overBudget: StopCondition<ToolSet> = ({ steps: done }) => spentBefore + done.reduce((sum, s) => sum + stepCost(s), 0) >= i.budgetUsd;
    cut = false;
    resetClock();
    // On "auto" the routine steps think little (see prepareStep); a step after a failed tool thinks fully.
    const autoThinking = i.thinking !== false && (!i.thinkingLevel || i.thinkingLevel === "auto");
    let lastFailed = false;
    try {
      const result = streamText({
        model: languageModel(i.conn, i.model),
        system: system(),
        messages,
        tools: deferral?.tools ?? tools,
        experimental_repairToolCall: repairToolJson,
        ...(i.only ? { activeTools: [i.only], toolChoice: "required" as const } : {}),
        // DeepSeek thinks by default, bills it as output and, with tools, gets it back as input on every later step.
        // After a cut the model thinks less: its thinking takes the same output limit (seen in a manual test).
        providerOptions:
          i.thinking === false && i.conn.preset === "deepseek"
            ? { deepseek: { thinking: { type: "disabled" } } }
            : round > 0
              ? thinkingOptions(i.conn.preset, "low")
              : i.thinkingLevel
                ? thinkingOptions(i.conn.preset, i.thinkingLevel)
                : undefined,
        prepareStep: async ({ messages, stepNumber }) => {
          let sent = messages;
          // Old thinking too, except Anthropic's: it is signed and refused once changed.
          // Only where the provider caches nothing, or near the model's window (measured on DeepSeek: a cached token costs a
          // fiftieth of a new one, and each move of the line sent the whole conversation at full price again).
          if (i.prune && ((!cacheSeen && PRUNE_CACHED) || sizeOf(sent) > memoryLimit(i.price) * TRIM_SHARE)) sent = pruneOutputs(sent, PROTECT, CHUNK, i.conn.preset !== "anthropic").messages;
          // Older outputs go shortened, on a copy, only once the history is half way to the model's limit: before it the
          // agent keeps what it read (asked for: as OpenCode; shortened at every step, files were read again and again).
          if (sent.length > KEEP_WHOLE && sizeOf(sent) > memoryLimit(i.price) * TRIM_SHARE) {
            sent = structuredClone(sent);
            compactHistory(sent);
          }
          const note = i.remind?.();
          if (note) sent = [...sent, { role: "user", content: note }];
          // A tool's answer cannot hold a picture with OpenAI-like providers: the screenshots come after it, as the user's.
          const seen = i.pictures?.();
          if (seen?.pictures.length) {
            sent = [
              ...sent,
              {
                role: "user",
                content: [
                  { type: "text", text: `[Drimvox: the screenshots you just took, ${seen.caption}. Look at them yourself.]` },
                  ...seen.pictures.map((png) => ({ type: "image" as const, image: png, mediaType: "image/png" })),
                ],
              },
            ];
          }
          // The same text as long as the notes stay the same: the provider's cache holds.
          const active = deferral?.active();
          traceStep(system(), deferral?.tools ?? tools, active, sent);
          // Thinking on "auto" (asked for: fewer tokens, the same quality): the first step, a step after a failed tool and
          // every tenth (to look at the plan again) think as the provider decides; the routine steps between think little.
          const routine = autoThinking && round === 0 && stepNumber > 0 && !lastFailed && (stepsBefore + stepNumber) % THINK_AGAIN_EVERY !== 0;
          const lean = routine ? thinkingOptions(i.conn.preset, "low") : undefined;
          return {
            system: system(),
            ...(active ? { activeTools: active } : {}),
            ...(sent === messages ? {} : { messages: sent }),
            ...(lean ? { providerOptions: lean } : {}),
          };
        },
        stopWhen: [
          hasToolCall("finish"),
          ...(i.stopTools ?? []).map((name) => hasToolCall(name)),
          isStepCount((i.maxSteps ?? MAX_STEPS) - stepsBefore),
          overBudget,
          ...(i.stopWhen ? [() => i.stopWhen!()] : []),
        ],
        // Busy providers (429, 5xx) are tried again after 2, 4, 8 and 16 seconds: an agent is in no hurry,
        // and some keys allow one request at a time, which a team of agents runs into.
        maxRetries: 4,
        abortSignal: AbortSignal.any([i.signal, silence.signal]),
        onError: () => {},
        onStepEnd: (step) => {
          steps++;
          lastFailed = step.content.some((part) => part.type === "tool-error");
          cut = step.finishReason === "length";
          said.push(...(step.response.messages as ModelMessage[]));
          const input = step.usage.inputTokens ?? 0;
          const output = step.usage.outputTokens ?? 0;
          const cost = stepCost(step);
          traceUsage(step.usage, cost, (step.providerMetadata as { drimvox?: { usage?: unknown } } | undefined)?.drimvox?.usage);
          if (usageOf(step.usage).cacheRead > 0) cacheSeen = true;
          spent += cost;
          i.onStep({
            messages: step.response.messages as ModelMessage[],
            inputTokens: input,
            outputTokens: output,
            cachedTokens: usageOf(step.usage).cacheRead,
            costUsd: cost,
            priced: billedUsd(step.providerMetadata, usdPerUnit) !== null || (i.price?.priceIn != null && i.price.priceOut != null),
          });
        },
      });

      let text = "";
      for await (const part of result.fullStream) {
        resetClock();
        if (part.type === "text-delta") text += part.text;
        else if (part.type === "text-end" && text.trim()) {
          i.onText(text.trim());
          lastText = text.trim();
          text = "";
        } else if (part.type === "tool-error" && !reported.has(part.toolCallId)) {
          // Calls the SDK rejected before running them (unknown tool, bad arguments) still belong in the feed.
          const message = part.error instanceof Error ? part.error.message : String(part.error);
          i.hooks.onCall({ callId: part.toolCallId, name: part.toolName, input: part.input });
          i.hooks.onResult({ callId: part.toolCallId, name: part.toolName, ok: false, output: `Error: ${message}` });
        } else if (part.type === "error") error = describeError(part.error);
      }
    } catch (err) {
      if (!i.signal.aborted && !silence.signal.aborted) error = describeError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  if (i.signal.aborted) return { kind: "stopped" };
  // What the answer teaches about the model, as a chat's does: busy, gone, no tools (the picker shows it).
  learnFromAnswer(i.conn, i.model, silence.signal.aborted ? { code: "timeout" } : error);
  if (silence.signal.aborted) return { kind: "error", error: { code: "timeout" } };
  if (error) return { kind: "error", error };
  const done = finished as { summary: string; commitMessage: string } | null;
  if (done) return { kind: "finished", ...done };
  if (spent >= i.budgetUsd) return { kind: "budget" };
  if (steps >= (i.maxSteps ?? MAX_STEPS)) return { kind: "steps" };
  // Cut by the output limit every time it went on: not done, and said so (seen: "done" with nothing written).
  if (cut) return { kind: "error", error: { code: "cut_off", detail: `The model's answer was cut by its output limit ${MAX_CUTS + 1} times in a row.` } };
  // The model ended with plain text instead of calling finish: take its last words as the summary.
  return { kind: "finished", summary: lastText || "—", commitMessage: null };
}

/** The same tools, each telling when it starts and ends. */
function paused(tools: ToolSet, clock: { start(): void; end(): void }): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const execute = t.execute;
      if (!execute) return [name, t];
      return [
        name,
        {
          ...t,
          execute: async (...args: Parameters<typeof execute>) => {
            clock.start();
            try {
              return await execute(...args);
            } finally {
              clock.end();
            }
          },
        },
      ];
    }),
  ) as ToolSet;
}
