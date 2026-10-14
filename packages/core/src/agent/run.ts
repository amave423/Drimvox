import type { ModelInfo, ProviderError } from "@artel/shared";
import { hasToolCall, isStepCount, streamText, type ModelMessage, type StopCondition, type ToolSet } from "ai";
import { describeError } from "../providers/errors";
import { billedUsd, costOf, usageOf } from "../providers/pricing";
import { usdRub } from "../rates";
import { languageModel } from "../providers/model";
import type { Connection } from "../providers/repo";
import { systemPrompt } from "./prompt";
import { buildTools, type ToolHooks } from "./tools";
import { compactHistory } from "./compact";
import { Workspace } from "./workspace";

export const MAX_STEPS = 60;

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
  /** After every finished step: the messages it produced and its usage. */
  onStep(step: { messages: ModelMessage[]; inputTokens: number; outputTokens: number; costUsd: number; priced: boolean }): void;
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

  // The provider's own bill when it sends one (in rubles for RouterAI), else the catalog's prices.
  const usdPerUnit = i.conn.currency === "RUB" ? 1 / (await usdRub()) : 1;
  const stepCost = (step: { usage: Parameters<typeof usageOf>[0]; providerMetadata?: unknown }) =>
    billedUsd(step.providerMetadata, usdPerUnit) ?? costOf(i.price, i.conn.preset, usageOf(step.usage)) ?? 0;
  const overBudget: StopCondition<ToolSet> = ({ steps: done }) => i.spentUsd + done.reduce((sum, s) => sum + stepCost(s), 0) >= i.budgetUsd;

  // A model that sends nothing for too long is treated like a provider error. While a tool runs (a long command,
  // a question to the user) the model is not the one keeping quiet: the clock stands still until the last tool ends.
  const silence = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = 0;
  const resetClock = () => {
    clearTimeout(timer);
    if (running === 0) timer = setTimeout(() => silence.abort(), i.idleTimeoutMs);
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
  const tools = paused({ ...buildTools(new Workspace(i.worktree), hooks, i.mode, i.extraTools), ...i.ownTools }, {
    start: () => {
      running++;
      clearTimeout(timer);
    },
    end: () => {
      running--;
      resetClock();
    },
  });

  resetClock();
  try {
    const result = streamText({
      model: languageModel(i.conn, i.model),
      system: i.system ?? (i.instructions ? `${systemPrompt(i.worktree)}\n\n${i.instructions}` : systemPrompt(i.worktree)),
      messages: i.messages,
      tools,
      // DeepSeek thinks by default, bills it as output and, with tools, gets it back as input on every later step.
      providerOptions: i.thinking === false && i.conn.preset === "deepseek" ? { deepseek: { thinking: { type: "disabled" } } } : undefined,
      // Old file reads and command outputs are cut once the conversation is big; see compact.ts.
      prepareStep: ({ messages }) => {
        const compacted = compactHistory(messages);
        return compacted === messages ? {} : { messages: compacted };
      },
      stopWhen: [hasToolCall("finish"), ...(i.stopTools ?? []).map((name) => hasToolCall(name)), isStepCount(MAX_STEPS), overBudget],
      // Busy providers (429, 5xx) are tried again after 2, 4, 8 and 16 seconds: an agent is in no hurry,
      // and some keys allow one request at a time, which a team of agents runs into.
      maxRetries: 4,
      abortSignal: AbortSignal.any([i.signal, silence.signal]),
      onError: () => {},
      onStepEnd: (step) => {
        steps++;
        const input = step.usage.inputTokens ?? 0;
        const output = step.usage.outputTokens ?? 0;
        const cost = stepCost(step);
        spent += cost;
        i.onStep({
          messages: step.response.messages as ModelMessage[],
          inputTokens: input,
          outputTokens: output,
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

  if (i.signal.aborted) return { kind: "stopped" };
  if (silence.signal.aborted) return { kind: "error", error: { code: "timeout" } };
  if (error) return { kind: "error", error };
  const done = finished as { summary: string; commitMessage: string } | null;
  if (done) return { kind: "finished", ...done };
  if (spent >= i.budgetUsd) return { kind: "budget" };
  if (steps >= MAX_STEPS) return { kind: "steps" };
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
