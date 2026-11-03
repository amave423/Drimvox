import type { ModelInfo, ProviderError } from "@drimvox/shared";
import { hasToolCall, isStepCount, streamText, type ModelMessage, type StopCondition, type ToolSet } from "ai";
import { describeError } from "../providers/errors";
import { billedUsd, costOf, usageOf } from "../providers/pricing";
import { usdRub } from "../rates";
import { languageModel } from "../providers/model";
import { isLocal, NO_LIMIT_MS } from "../budget";
import type { Connection } from "../providers/repo";
import { systemPrompt } from "./prompt";
import { buildTools, type ToolHooks } from "./tools";
import { cutPoint, memoryLimit, remember, sizeOf, withMemory, type Memory, type Remembered } from "./memory";
import { notesBlock } from "./notes";
import { compactHistory, KEEP_WHOLE } from "../work/compact";
import { repairToolJson } from "./repair";
import { deferTools } from "./deferred";
import { Workspace } from "./workspace";

export const MAX_STEPS = 60;

/** A summary of the older work written in the background, and what came of it (undefined while it is written). */
type Summary = { result: Promise<Remembered | null>; done: Remembered | null | undefined };

/** The share of the memory's limit at which its summary starts in the background. */
const EARLY_SUMMARY = 0.85;

/** Rounds a pass may go on for after the provider cut an answer by its output limit. */
const MAX_CUTS = 2;
const CUT_NOTE =
  "Your last message was cut off by the output limit, and nothing in its unfinished part was done. Go on from there. Write a big file in parts: write_file with the first part, then edit_file to add the rest.";

export interface RunInput {
  conn: Connection;
  model: string;
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
  /** What the agent remembers of its older work; with onMemory, a new summary replaces the older part when it grows. */
  memory?: Memory | null;
  onMemory?(memory: Memory, usage: { inputTokens: number; outputTokens: number; costUsd: number }): void;
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
  /** Money already spent on the task and the limit for it. */
  spentUsd: number;
  budgetUsd: number;
  signal: AbortSignal;
  idleTimeoutMs: number;
  hooks: Omit<ToolHooks, "onFinish">;
  onText(text: string): void;
  /** What the model thinks before it speaks, as it comes (seen live: a model thought for two minutes, and the screen stayed empty). */
  onReasoning?(text: string): void;
  /** After every finished step: the messages it produced and its usage. */
  onStep(step: { messages: ModelMessage[]; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; priced: boolean }): void;
}

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
  let memory = i.memory ?? null;

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
  const tools = paused({ ...base, ...(i.noFinish || !finishTool ? {} : { finish: finishTool }), ...i.ownTools }, {
    start: () => {
      running++;
      clearTimeout(timer);
    },
    end: () => {
      running--;
      resetClock();
    },
  });

  // The rare tools wait until the model loads them (deferred.ts); a step with one tool to call keeps just that one.
  const deferral = i.only ? null : deferTools(tools);

  // A summary of the older work being written in the background, and what came of it (undefined while it is written).
  let writing = null as Summary | null;
  const adopt = (r: Remembered) => {
    const cost = costOf(i.price, i.conn.preset, usageOf({ inputTokens: r.inputTokens, outputTokens: r.outputTokens })) ?? 0;
    spent += cost;
    memory = r.memory;
    i.onMemory!(memory, { inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: cost });
  };

  // The project's notes (AGENTS.md) start every request, read afresh: the agent's own update shows at the next step.
  const system = () => [i.system ?? systemPrompt(i.worktree), i.system ? "" : i.instructions, notesBlock(i.worktree)].filter(Boolean).join("\n\n");

  // A round cut by the provider's output limit goes on from what it said and did (seen live: "Now I write the styles…",
  // and the answer ended there, counted as done, the file never written).
  const start = [...i.messages];
  const said: ModelMessage[] = [];
  let cut = false;
  for (let round = 0; round <= MAX_CUTS; round++) {
    if (round > 0 && (!cut || finished || error || i.signal.aborted || silence.signal.aborted)) break;
    if (round > 0 && (spent >= i.budgetUsd || steps >= (i.maxSteps ?? MAX_STEPS) || i.stopWhen?.())) break;
    const messages: ModelMessage[] = round === 0 ? start : [...start, ...said, { role: "user", content: CUT_NOTE }];
    const stepsBefore = steps;
    const spentBefore = spent;
    const overBudget: StopCondition<ToolSet> = ({ steps: done }) => spentBefore + done.reduce((sum, s) => sum + stepCost(s), 0) >= i.budgetUsd;
    cut = false;
    resetClock();
    try {
      const result = streamText({
        model: languageModel(i.conn, i.model),
        system: system(),
        messages,
        tools: deferral?.tools ?? tools,
        experimental_repairToolCall: repairToolJson,
        ...(i.only ? { activeTools: [i.only], toolChoice: "required" as const } : {}),
        // DeepSeek thinks by default, bills it as output and, with tools, gets it back as input on every later step.
        providerOptions: i.thinking === false && i.conn.preset === "deepseek" ? { deepseek: { thinking: { type: "disabled" } } } : undefined,
        // Near the model's context, the older work becomes one summary; see memory.ts.
        prepareStep: async ({ messages }) => {
          // A summary written in the background meanwhile takes over the older work now.
          if (writing?.done !== undefined) {
            if (writing.done) adopt(writing.done);
            writing = null;
          }
          let sent = withMemory(messages, memory);
          const limit = memoryLimit(i.price);
          const size = sizeOf(sent);
          // Before the limit the summary starts in the background and the agent goes on (as OpenCode does); only at the
          // limit does it wait for it.
          if (i.onMemory && !writing && size > limit * EARLY_SUMMARY) {
            const upTo = cutPoint(messages, memory, limit);
            if (upTo !== null) {
              const job: Summary = { result: Promise.resolve(null), done: undefined };
              job.result = remember(i.conn, i.model, i.worktree, messages, memory, upTo, i.signal).then(
                (r) => (job.done = r),
                // Without a summary the whole conversation goes; a later step tries again.
                () => (job.done = null),
              );
              writing = job;
            }
          }
          if (writing && size > limit) {
            running++;
            clearTimeout(timer);
            try {
              const r = await writing.result;
              if (r) adopt(r);
              writing = null;
              sent = withMemory(messages, memory);
            } finally {
              running--;
              resetClock();
            }
          }
          // Within one pass every step resent every file and output read before (seen in the user's runs: 3 million input
          // tokens per answer). Older outputs go shortened, on a copy; the newest steps and the skills stay whole.
          if (sent.length > KEEP_WHOLE) {
            sent = structuredClone(sent);
            compactHistory(sent);
          }
          const note = i.remind?.();
          if (note) sent = [...sent, { role: "user", content: note }];
          // The same text as long as the notes stay the same: the provider's cache holds.
          const active = deferral?.active();
          return { system: system(), ...(active ? { activeTools: active } : {}), ...(sent === messages ? {} : { messages: sent }) };
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
          cut = step.finishReason === "length";
          said.push(...(step.response.messages as ModelMessage[]));
          const input = step.usage.inputTokens ?? 0;
          const output = step.usage.outputTokens ?? 0;
          const cost = stepCost(step);
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
        else if (part.type === "reasoning-delta") i.onReasoning?.(part.text);
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
  if (silence.signal.aborted) return { kind: "error", error: { code: "timeout" } };
  if (error) return { kind: "error", error };
  const done = finished as { summary: string; commitMessage: string } | null;
  if (done) return { kind: "finished", ...done };
  if (spent >= i.budgetUsd) return { kind: "budget" };
  if (steps >= (i.maxSteps ?? MAX_STEPS)) return { kind: "steps" };
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
