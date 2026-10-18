import { mergeOptions, thinkingOptions } from "./thinking";
import { toModelMessages } from "./history";
import { notesBlock } from "../agent/notes";
import { changedSince, checkpoint, dropCheckpoint } from "./checkpoint";
import { FOLDER_STEPS, folderHint } from "./folder";
import { availabilityFromError, canCheck, noteAvailability } from "../providers/availability";
import type { ModelInfo, ProviderError, StreamEvent } from "@artel/shared";
import type { ThinkingLevel, WebMode } from "@artel/shared";
import { isStepCount, streamText, type ToolSet } from "ai";
import { cliReply } from "../cli/chat";
import { isCli } from "../cli/kinds";
import { WEB_HINT, webTools } from "../internet/tools";
import type { WebAccess } from "../internet/web";
import { findModel } from "../providers/catalog";
import { billedUsd, costOf, usageOf } from "../providers/pricing";
import { usdRub } from "../rates";
import { describeError } from "../providers/errors";
import { nowLine } from "../now";
import { languageModel } from "../providers/model";
import type { Connection } from "../providers/repo";
import type { ChatRepo } from "./repo";

/** What the chat can show, so models use it instead of ASCII art. */
export const FORMAT_HINT =
  "Answers are shown as Markdown with tables, LaTeX math ($...$ inline, $$...$$ for blocks) and highlighted code. " +
  "For diagrams and charts write a ```mermaid block: flowchart, sequenceDiagram, pie, xychart-beta for bar and line charts, gantt, mindmap.";

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
  web: WebMode;
  webAccess: WebAccess;
  /** Tools besides the internet ones, such as the user's MCP servers. */
  extraTools?: ToolSet;
  /** Where command-line agents keep a folder per chat. */
  cliDir?: string;
  /** How much the model thinks before it answers. */
  thinking?: ThinkingLevel;
  /** Files uploaded for this message. */
  attachments?: string[];
  /** The model sees pictures: attached ones go to it as pictures, not as a note. */
  vision?: boolean;
  /** The chat's folder: the model works in it, and it is snapshotted before the answer so the answer can be undone. */
  folder?: string | null;
  emit(event: StreamEvent): Promise<void>;
}

/**
 * Saves the user's message, streams the model's answer to `emit`, then saves the answer
 * with its usage and cost. Provider errors end up on the answer, not as exceptions.
 */
export async function reply(i: ReplyInput): Promise<void> {
  if (isCli(i.conn.preset) && i.cliDir) return cliReply(i, i.cliDir, FORMAT_HINT);
  const added = i.chats.addMessage({ chatId: i.chatId, role: "user", content: i.content, status: "done" });
  if (i.attachments?.length) i.chats.attachments.attach(i.chatId, added.id, i.attachments);
  const userMessage = i.chats.message(added.id)!;
  i.chats.nameIfUntitled(i.chatId, i.content);
  const history = toModelMessages(i.chats.history(i.chatId), i.chats.attachments, i.vision !== false);
  const answer = i.chats.addMessage({
    chatId: i.chatId,
    role: "assistant",
    content: "",
    status: "streaming",
    providerId: i.conn.id,
    model: i.model,
  });
  await i.emit({ type: "start", userMessage, assistantMessageId: answer.id });
  // The folder as it was before this answer: "Undo" brings it back. No git, no snapshot.
  const ref = `refs/artel/chat/${i.chatId}/${answer.id}`;
  const snapshot = i.folder ? await checkpoint(i.folder, ref).catch(() => null) : null;

  let text = "";
  let reasoning = "";
  let error: ProviderError | null = null;
  let usage: Parameters<typeof usageOf>[0];
  let finishReason: string | undefined;
  /** The provider's own bill in its currency, summed over the steps, when it sends one. */
  let billed: number | null = null;

  // Some hosted models sit in a queue or hang; every streamed part resets the clock.
  const silence = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetClock = () => {
    clearTimeout(timer);
    timer = setTimeout(() => silence.abort(), i.idleTimeoutMs);
  };
  resetClock();

  const tools: ToolSet = {
    ...(i.web === "free" ? webTools(i.webAccess, { onCall: (call) => void i.emit({ type: "tool", name: call.name, input: call.input }) }) : {}),
    ...i.extraTools,
  };
  try {
    const result = streamText({
      model: languageModel(i.conn, i.model),
      system: [
        nowLine(),
        FORMAT_HINT,
        i.web === "free" ? WEB_HINT : i.web === "provider" ? "Use the web search results you are given and name the sources." : "",
        i.folder ? folderHint(i.folder) : "",
        i.folder ? notesBlock(i.folder) : "",
      ]
        .filter(Boolean)
        .join("\n"),
      messages: history,
      ...(Object.keys(tools).length
        ? {
            tools,
            // Search, read a page or two, call a tool or two, answer.
            stopWhen: isStepCount(i.folder ? FOLDER_STEPS : 8),
          }
        : {}),
      // OpenRouter and RouterAI search on their side for a fee; the plugin goes into the request body.
      // How much the model thinks, and the provider's own search, go into the request body.
      providerOptions: mergeOptions(
        i.web === "provider" ? { [i.conn.preset]: { plugins: [{ id: "web", max_results: 5 }] } } : undefined,
        thinkingOptions(i.conn.preset, i.thinking ?? "auto"),
      ),
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
      } else if (part.type === "finish-step") {
        // Each step's own bill, when the provider sends one: an answer with searches takes several steps.
        const step = billedUsd(part.providerMetadata, 1);
        if (step !== null) billed = (billed ?? 0) + step;
      } else if (part.type === "finish") {
        usage = part.totalUsage;
        finishReason = part.finishReason;
      }
    }
  } catch (err) {
    if (!i.signal.aborted) error = describeError(err);
  } finally {
    clearTimeout(timer);
  }

  const stopped = i.signal.aborted;
  if (!stopped && silence.signal.aborted) error = { code: "timeout" };
  // Seen live: a model thought 90 000 characters and wrote nothing; an empty "done" answer said nothing of it.
  if (!stopped && !error && !text.trim() && reasoning.trim()) error = { code: "no_answer" };
  // The model ran out of room (seen live: a local model with a small context stopped mid-answer, as if it had
  // finished). The answer stays a done one, so "go on" brings it back to the model, with a note under it.
  const cutOff = !stopped && !error && finishReason === "length" && text !== "";
  // What this answer says about the model: the picker hides free models that are gone.
  const learned = stopped ? null : error ? availabilityFromError(error.code) : "ok";
  if (learned && canCheck(i.conn)) noteAvailability(i.conn, i.model, learned);
  const inputTokens = usage?.inputTokens ?? null;
  const outputTokens = usage?.outputTokens ?? null;
  const price = inputTokens !== null && outputTokens !== null ? await findModel(i.conn, i.model) : undefined;

  // Undo only for an answer that changed something.
  if (snapshot && i.folder) {
    if (await changedSince(i.folder, snapshot).catch(() => false)) i.chats.setCheckpoint(answer.id, snapshot);
    else await dropCheckpoint(i.folder, ref).catch(() => {});
  }
  const message = i.chats.finishAnswer(answer.id, {
    content: text,
    reasoning: reasoning || null,
    status: stopped ? "stopped" : error ? "error" : "done",
    inputTokens,
    outputTokens,
    costUsd:
      billed !== null
        ? billed / (i.conn.currency === "RUB" ? await usdRub() : 1)
        : inputTokens !== null && outputTokens !== null
          ? costOf(price, i.conn.preset, usageOf(usage))
          : null,
    error: stopped ? null : (error ?? (cutOff ? { code: "cut_off" } : null)),
  });
  if (!stopped) await i.emit({ type: "done", message });
}


