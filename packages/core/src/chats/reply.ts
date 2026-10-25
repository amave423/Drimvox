import { mergeOptions, thinkingOptions } from "./thinking";
import { toModelMessages } from "./history";
import { notesBlock } from "../agent/notes";
import { changedSince, checkpoint, dropCheckpoint } from "./checkpoint";
import { FOLDER_STEPS, folderHint } from "./folder";
import { cutPoint, memoryLimit, remember, sizeOf, withMemory, type Memory } from "../agent/memory";
import { availabilityFromError, canCheck, noteAvailability } from "../providers/availability";
import type { ModelInfo, ProviderError, StreamEvent } from "@drimvox/shared";
import type { ThinkingLevel, WebMode } from "@drimvox/shared";
import { isStepCount, streamText, type ModelMessage, type ToolSet } from "ai";
import { cliReply } from "../cli/chat";
import { isCli } from "../cli/kinds";
import { FAIR_USE_HINT, WEB_HINT, webTools } from "../internet/tools";
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
/** Told on the last step an answer may take: no tools, a summary, so it never ends empty. */
const LAST_STEP =
  'This is the last step of this answer: do not call tools. Write the answer now, in the user\'s language: what is done, where the results are, and what is left, so the user can say "go on".';

/** Steps of an answer with the internet or the user's tools: research takes searches and pages (seen: 8 steps stopped five answers of eight). */
export const WEB_STEPS = 60;

/** Rounds an answer cut by its length may go on for, in the same message. */
const MAX_CONTINUES = 2;
const CONTINUE = "Your answer was cut off by its length. Continue exactly where it stopped: no repeating, no introduction.";

/** Seen live: "I need names in English" turned the whole conversation into English. */
const LANGUAGE_HINT =
  "Answer in the language the user writes in. When the user asks for names, words or a text in another language, only those are in that language; your answer stays in the user's.";

/** How long a model on this computer may stay silent: reading a long context before the first word takes a while. */
const LOCAL_IDLE_MS = 10 * 60_000;

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
  /** An edit of an earlier message: the new one follows what that one did, and keeps its files unless others are sent. */
  edit?: { parentId: string | null; from: string };
  /** The model sees pictures: attached ones go to it as pictures, not as a note. */
  vision?: boolean;
  /** The chat's folder: the model works in it, and it is snapshotted before the answer so the answer can be undone. */
  folder?: string | null;
  /** The tools called so far in this answer, kept with it when it is saved. */
  activity?: () => { name: string; input: string }[];
  /** A project task's conversation (docs/specs/project-work.md): its rules and how many steps an answer may take. */
  work?: { system: string; steps: number };
  emit(event: StreamEvent): Promise<void>;
}

/**
 * Saves the user's message, streams the model's answer to `emit`, then saves the answer
 * with its usage and cost. Provider errors end up on the answer, not as exceptions.
 */
export async function reply(i: ReplyInput): Promise<void> {
  if (isCli(i.conn.preset) && i.cliDir) return cliReply(i, i.cliDir, FORMAT_HINT);
  const added = i.chats.addMessage({ chatId: i.chatId, role: "user", content: i.content, status: "done", ...(i.edit ? { parentId: i.edit.parentId } : {}) });
  if (i.attachments?.length) i.chats.attachments.attach(i.chatId, added.id, i.attachments);
  else if (i.edit) i.chats.attachments.copy(i.edit.from, added.id);
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
  const ref = `refs/drimvox/chat/${i.chatId}/${answer.id}`;
  const snapshot = i.folder ? await checkpoint(i.folder, ref).catch(() => null) : null;

  let text = "";
  /** A step ended: the next text starts a new paragraph. */
  let newStep = false;
  let reasoning = "";
  let error: ProviderError | null = null;
  let usage: Parameters<typeof usageOf>[0];
  let finishReason: string | undefined;
  /** The provider's own bill in its currency, summed over the steps, when it sends one. */
  let billed: number | null = null;

  // Some hosted models sit in a queue or hang; every streamed part resets the clock. A model on this computer reads a
  // long context (pages it opened) for minutes before its first word, so it gets longer.
  const idleMs = i.conn.preset === "ollama" || i.conn.preset === "lmstudio" ? Math.max(i.idleTimeoutMs, LOCAL_IDLE_MS) : i.idleTimeoutMs;
  const silence = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetClock = () => {
    clearTimeout(timer);
    timer = setTimeout(() => silence.abort(), idleMs);
  };
  resetClock();

  // Memory for long work: the model's context decides when the older part of the answer is summarized.
  const limit = i.folder ? memoryLimit(await findModel(i.conn, i.model)) : 0;
  let extraUsage = { inputTokens: 0, outputTokens: 0 };
  const tools: ToolSet = {
    ...(i.web === "free" ? webTools(i.webAccess, { onCall: (call) => void i.emit({ type: "tool", name: call.name, input: call.input }) }) : {}),
    ...i.extraTools,
  };
  // Research takes room: the internet, or tools of the user's servers (seen: a browser server stopped at 8 steps).
  const steps = i.work?.steps || (i.folder ? FOLDER_STEPS : i.web === "free" || Object.keys(i.extraTools ?? {}).length ? WEB_STEPS : 8);
  const memory = i.folder ? memoryStep(i, limit, (u) => (extraUsage = addUsage(extraUsage, u))) : null;
  /** The answer reached its last step: what it says there is a summary of unfinished work. */
  let lastStep = false;
  /** What the earlier rounds said and did: a round cut by the answer's length goes on from there. */
  const said: ModelMessage[] = [];
  for (let round = 0; round <= MAX_CONTINUES; round++) {
    resetClock();
    // The next round goes on mid-sentence, not as a new paragraph.
    newStep = false;
    try {
      const result = streamText({
        model: languageModel(i.conn, i.model),
        system: [
          nowLine(),
          LANGUAGE_HINT,
          FORMAT_HINT,
          // With the internet the rule comes in WEB_HINT; the user's own tools (a browser server) need it too.
          Object.keys(tools).length && i.web !== "free" ? FAIR_USE_HINT : "",
          i.web === "free" ? WEB_HINT : i.web === "provider" ? "Use the web search results you are given and name the sources." : "",
          i.folder ? folderHint(i.folder) : "",
          i.folder ? notesBlock(i.folder) : "",
          i.work?.system ?? "",
        ]
          .filter(Boolean)
          .join("\n"),
        messages: round === 0 ? history : [...history, ...said, { role: "user" as const, content: CONTINUE }],
        ...(Object.keys(tools).length
          ? {
              tools,
              // Search, read a page or two, call a tool or two, answer.
              stopWhen: isStepCount(steps),
              // Long work in a folder: once the answer nears the model's context, its older part becomes a summary. The
              // last step is for the summary (seen live: all 40 steps went on tools, the answer came empty).
              prepareStep: async (o: { stepNumber: number; messages: ModelMessage[] }) => {
                const base: { messages?: ModelMessage[] } = memory ? await memory(o) : {};
                if (o.stepNumber < steps - 1) return base;
                lastStep = true;
                return { ...base, toolChoice: "none" as const, messages: [...(base.messages ?? o.messages), { role: "user" as const, content: LAST_STEP }] };
              },
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
        // While Drimvox itself runs a tool (a search, a page, a command), the model is not silent: the clock waits (seen:
        // an answer cut as "silent" while a search went on).
        if (part.type === "tool-call") clearTimeout(timer);
        else resetClock();
        if (part.type === "text-delta") {
          // What the model says after a tool call is a new paragraph (seen live: "…folder.The folder is empty…").
          const piece = newStep && text && !/\n\s*$/.test(text) ? `\n\n${part.text.trimStart()}` : part.text;
          newStep = false;
          text += piece;
          await i.emit({ type: "text", text: piece });
        } else if (part.type === "reasoning-delta") {
          reasoning += part.text;
          await i.emit({ type: "reasoning", text: part.text });
        } else if (part.type === "error") {
          error = describeError(part.error);
        } else if (part.type === "finish-step") {
          newStep = true;
          // Each step's own bill, when the provider sends one: an answer with searches takes several steps.
          const step = billedUsd(part.providerMetadata, 1);
          if (step !== null) billed = (billed ?? 0) + step;
        } else if (part.type === "finish") {
          usage = addTotals(usage, part.totalUsage);
          finishReason = part.finishReason;
        }
      }
      // Cut by the answer's length (seen live: a long page of code stopped mid-tag): the next round goes on from there.
      if (finishReason === "length" && !error && text.trim() && round < MAX_CONTINUES && !i.signal.aborted) {
        said.push(...((await result.response).messages as ModelMessage[]));
        continue;
      }
    } catch (err) {
      if (!i.signal.aborted) error = describeError(err);
    } finally {
      clearTimeout(timer);
    }
    break;
  }

  const stopped = i.signal.aborted;
  if (!stopped && silence.signal.aborted) error = { code: "timeout" };
  // Seen live: a model thought 90 000 characters and wrote nothing; an empty "done" answer said nothing of it.
  // Stopped on a tool call (the steps ran out): not "thought and did not answer".
  if (!stopped && !error && !text.trim() && finishReason === "tool-calls") error = { code: "step_limit" };
  if (!stopped && !error && !text.trim() && reasoning.trim()) error = { code: "no_answer" };
  // The model ran out of room (seen live: a local model with a small context stopped mid-answer, as if it had
  // finished). The answer stays a done one, so "go on" brings it back to the model, with a note under it.
  const cutOff = !stopped && !error && finishReason === "length" && text !== "";
  // What this answer says about the model: the picker hides free models that are gone.
  const learned = stopped ? null : error ? availabilityFromError(error.code) : "ok";
  if (learned && canCheck(i.conn)) noteAvailability(i.conn, i.model, learned);
  // The summaries written for the memory are paid for too.
  if (usage && (extraUsage.inputTokens || extraUsage.outputTokens)) {
    usage = { ...usage, inputTokens: (usage.inputTokens ?? 0) + extraUsage.inputTokens, outputTokens: (usage.outputTokens ?? 0) + extraUsage.outputTokens };
  }
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
    error: stopped ? null : (error ?? (cutOff ? { code: "cut_off" } : lastStep ? { code: "step_limit" } : null)),
    activity: i.activity?.(),
  });
  if (!stopped) await i.emit({ type: "done", message });
}

type Totals = Parameters<typeof usageOf>[0];

/** The usage of the rounds of one answer, together. */
function addTotals(a: Totals, b: Totals): Totals {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  return {
    ...b,
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    inputTokenDetails: { cacheReadTokens: sum(a.inputTokenDetails?.cacheReadTokens, b.inputTokenDetails?.cacheReadTokens) },
  } as Totals;
}

const addUsage = (a: { inputTokens: number; outputTokens: number }, b: { inputTokens: number; outputTokens: number }) => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

/**
 * The agent's memory inside one long answer (agent/memory.ts): past the limit, the older steps are told by a summary the
 * model writes, with the current text of the files it changed. Without this a task's answer of 200 steps outgrew the
 * model's context.
 */
function memoryStep(i: ReplyInput, limit: number, spent: (u: { inputTokens: number; outputTokens: number }) => void) {
  let memory: Memory | null = null;
  return async ({ messages }: { messages: ModelMessage[] }) => {
    let sent = withMemory(messages, memory);
    const upTo = sizeOf(sent) > limit ? cutPoint(messages, memory, limit) : null;
    if (upTo !== null && i.folder) {
      try {
        const r = await remember(i.conn, i.model, i.folder, messages, memory, upTo, i.signal);
        memory = r.memory;
        spent({ inputTokens: r.inputTokens, outputTokens: r.outputTokens });
        sent = withMemory(messages, memory);
      } catch {
        // Without a summary the step goes as it is; the next one tries again.
      }
    }
    return sent === messages ? {} : { messages: sent };
  };
}
