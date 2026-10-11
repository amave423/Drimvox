import type { ModelInfo, ProviderError, StreamEvent } from "@artel/shared";
import { streamText } from "ai";
import { findModel } from "../providers/catalog";
import { describeError } from "../providers/errors";
import { languageModel } from "../providers/model";
import type { Connection } from "../providers/repo";
import type { ChatRepo } from "./repo";

export interface ReplyInput {
  chats: ChatRepo;
  chatId: string;
  conn: Connection;
  model: string;
  content: string;
  /** Aborted when the client disconnects or presses Stop. */
  signal: AbortSignal;
  /** Give up when the model sends nothing for this long. */
  idleTimeoutMs: number;
  emit(event: StreamEvent): Promise<void>;
}

/**
 * Saves the user's message, streams the model's answer to `emit`, then saves the answer
 * with its usage and cost. Provider errors end up on the answer, not as exceptions.
 */
export async function reply(i: ReplyInput): Promise<void> {
  const userMessage = i.chats.addMessage({ chatId: i.chatId, role: "user", content: i.content, status: "done" });
  i.chats.nameIfUntitled(i.chatId, i.content);
  const history = i.chats.history(i.chatId);
  const answer = i.chats.addMessage({
    chatId: i.chatId,
    role: "assistant",
    content: "",
    status: "streaming",
    providerId: i.conn.id,
    model: i.model,
  });
  await i.emit({ type: "start", userMessage, assistantMessageId: answer.id });

  let text = "";
  let reasoning = "";
  let error: ProviderError | null = null;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;

  // Some hosted models sit in a queue or hang; every streamed part resets the clock.
  const silence = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetClock = () => {
    clearTimeout(timer);
    timer = setTimeout(() => silence.abort(), i.idleTimeoutMs);
  };
  resetClock();

  try {
    const result = streamText({
      model: languageModel(i.conn, i.model),
      messages: history,
      maxRetries: 1,
      abortSignal: AbortSignal.any([i.signal, silence.signal]),
      onError: () => {},
    });
    for await (const part of result.fullStream) {
      resetClock();
      if (part.type === "text-delta") {
        text += part.text;
        await i.emit({ type: "text", text: part.text });
      } else if (part.type === "reasoning-delta") {
        reasoning += part.text;
        await i.emit({ type: "reasoning", text: part.text });
      } else if (part.type === "error") {
        error = describeError(part.error);
      } else if (part.type === "finish") {
        usage = part.totalUsage;
      }
    }
  } catch (err) {
    if (!i.signal.aborted) error = describeError(err);
  } finally {
    clearTimeout(timer);
  }

  const stopped = i.signal.aborted;
  if (!stopped && silence.signal.aborted) error = { code: "timeout" };
  const inputTokens = usage?.inputTokens ?? null;
  const outputTokens = usage?.outputTokens ?? null;
  const price = inputTokens !== null && outputTokens !== null ? await findModel(i.conn, i.model) : undefined;

  const message = i.chats.finishAnswer(answer.id, {
    content: text,
    reasoning: reasoning || null,
    status: stopped ? "stopped" : error ? "error" : "done",
    inputTokens,
    outputTokens,
    costUsd: cost(price, inputTokens, outputTokens),
    error: stopped ? null : error,
  });
  if (!stopped) await i.emit({ type: "done", message });
}

function cost(model: ModelInfo | undefined, input: number | null, output: number | null): number | null {
  if (!model || model.priceIn === null || model.priceOut === null || input === null || output === null) return null;
  return (input * model.priceIn + output * model.priceOut) / 1_000_000;
}
