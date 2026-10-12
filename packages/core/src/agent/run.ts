import type { ModelInfo, ProviderError } from "@artel/shared";
import { hasToolCall, isStepCount, streamText, type ModelMessage, type StopCondition, type ToolSet } from "ai";
import { describeError } from "../providers/errors";
import { languageModel } from "../providers/model";
import type { Connection } from "../providers/repo";
import { systemPrompt } from "./prompt";
import { buildTools, type ToolHooks } from "./tools";
import { Workspace } from "./workspace";

export const MAX_STEPS = 60;

export interface RunInput {
  conn: Connection;
  model: string;
  price: ModelInfo | undefined;
  worktree: string;
  /** Conversation so far, ending with the new user message. */
  messages: ModelMessage[];
  /** "read" for the interview and the spec: no edits, no commands. */
  mode: "read" | "write";
  /** Tools of the current step, such as ask_questions or propose_spec. */
  extraTools?: ToolSet;
  /** Tools that report their calls to the feed themselves (internet, skills, pictures); passed as they are. */
  ownTools?: ToolSet;
  /** Calling any of these ends the pass, like finish does. */
  stopTools?: string[];
  /** The current step's instructions, added to the system prompt. */
  instructions?: string;
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

  const costOf = (input: number, output: number) =>
    i.price?.priceIn != null && i.price.priceOut != null
      ? Number(((input * i.price.priceIn + output * i.price.priceOut) / 1_000_000).toFixed(9))
      : 0;
  const overBudget: StopCondition<ToolSet> = ({ steps: done }) =>
    i.spentUsd + done.reduce((sum, s) => sum + costOf(s.usage.inputTokens ?? 0, s.usage.outputTokens ?? 0), 0) >= i.budgetUsd;

  // A model that sends nothing for too long is treated like a provider error.
  const silence = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetClock = () => {
    clearTimeout(timer);
    timer = setTimeout(() => silence.abort(), i.idleTimeoutMs);
  };

  // Calls our own tools reported; the rest are the SDK's rejections.
  const reported = new Set<string>();
  const hooks: ToolHooks = {
    ...i.hooks,
    onCall: (call) => {
      reported.add(call.callId);
      i.hooks.onCall(call);
    },
    // Waiting for the user is not silence from the model.
    askApproval: async (command, reason, signal) => {
      clearTimeout(timer);
      try {
        return await i.hooks.askApproval(command, reason, signal);
      } finally {
        resetClock();
      }
    },
    onFinish: (result: { summary: string; commitMessage: string }) => (finished = result),
  };
  const tools = { ...buildTools(new Workspace(i.worktree), hooks, i.mode, i.extraTools), ...i.ownTools };

  resetClock();
  try {
    const result = streamText({
      model: languageModel(i.conn, i.model),
      system: i.instructions ? `${systemPrompt(i.worktree)}\n\n${i.instructions}` : systemPrompt(i.worktree),
      messages: i.messages,
      tools,
      stopWhen: [hasToolCall("finish"), ...(i.stopTools ?? []).map((name) => hasToolCall(name)), isStepCount(MAX_STEPS), overBudget],
      maxRetries: 1,
      abortSignal: AbortSignal.any([i.signal, silence.signal]),
      onError: () => {},
      onStepEnd: (step) => {
        steps++;
        const input = step.usage.inputTokens ?? 0;
        const output = step.usage.outputTokens ?? 0;
        const cost = costOf(input, output);
        spent += cost;
        i.onStep({
          messages: step.response.messages as ModelMessage[],
          inputTokens: input,
          outputTokens: output,
          costUsd: cost,
          priced: i.price?.priceIn != null && i.price.priceOut != null,
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
