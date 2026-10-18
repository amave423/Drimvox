import type { ModelInfo } from "@artel/shared";
import { generateText, type ModelMessage } from "ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { languageModel } from "../providers/model";
import type { Connection } from "../providers/repo";

/**
 * What the agent remembers of its older work. Seen live: cutting old file reads and command outputs piece by piece
 * made the agent forget the files it was editing, read them again in pieces and miss its edits (2029 tool calls for
 * one stage); the cuts also broke the provider's cache. Instead, once the conversation nears the model's context,
 * its older part is replaced by one summary the model writes, with the current text of the files it changed there.
 * The summary stays the same until the next one, so the start of every request is the same and the cache holds.
 */
export interface Memory {
  /** Messages before this index are told by the summary; the first message (the task) is always sent as it is. */
  upTo: number;
  summary: string;
}

/** The share of the limit the newest messages may take whole after a summary: room to work before the next one. */
const KEEP_SHARE = 0.4;
/** Current text of changed files sent with a summary, at most. */
const WORKING_SET = 40_000;
/** How much of the older work the summarizer reads, at most: the newest part. */
const SUMMARIZER_INPUT = 300_000;

/** Characters of conversation that trigger a summary: 60 % of the model's context, about 3.5 characters a token. */
export function memoryLimit(price: ModelInfo | undefined): number {
  return price?.contextLength ? Math.min(Math.floor(price.contextLength * 0.6 * 3.5), MAX_SENT) : 200_000;
}

/**
 * At most this much is sent a step, whatever the model holds: a million-token model got whole histories of 100 000
 * tokens a step (seen live), which cost money and the model's focus.
 */
const MAX_SENT = 400_000;

/** The conversation as the model gets it: the task, the summary, then the newer messages. */
export function withMemory(messages: ModelMessage[], memory: Memory | null): ModelMessage[] {
  if (!memory || memory.upTo <= 1 || memory.upTo > messages.length) return messages;
  return [messages[0]!, { role: "user", content: memory.summary }, ...messages.slice(memory.upTo)];
}

export const sizeOf = (messages: ModelMessage[]) => JSON.stringify(messages).length;

/**
 * Where a new summary may end: before an assistant message, so that the newest messages after it take no more than
 * their share of the limit (at least the last exchange stays). Null when there is nothing older to summarize.
 */
export function cutPoint(messages: ModelMessage[], memory: Memory | null, limit: number): number | null {
  const floor = Math.max(1, memory?.upTo ?? 1);
  let kept = 0;
  let cut: number | null = null;
  for (let i = messages.length - 1; i > floor; i--) {
    kept += JSON.stringify(messages[i]).length;
    if (messages[i]!.role !== "assistant") continue;
    if (cut !== null && kept > limit * KEEP_SHARE) break;
    cut = i;
  }
  return cut !== null && cut < messages.length - 1 ? cut : null;
}

export interface Remembered {
  memory: Memory;
  inputTokens: number;
  outputTokens: number;
}

/** Writes a new summary of everything before the cut, the earlier summary included. */
export async function remember(
  conn: Connection,
  model: string,
  worktree: string,
  messages: ModelMessage[],
  memory: Memory | null,
  upTo: number,
  signal?: AbortSignal,
): Promise<Remembered> {
  const older = withMemory(messages.slice(0, upTo), memory).slice(1);
  const log = transcript(older);
  const result = await generateText({
    model: languageModel(conn, model),
    system:
      "You keep the working memory of a coding agent. From its log, write what it must remember to go on without the log: " +
      "the goal and what the user asked for; what is done, file by file, and why; decisions made; commands that build, " +
      "test and run the project; what failed and how it was fixed; what is left to do. Plain text, at most 600 words, " +
      "in the language of the task. Facts only.",
    messages: [{ role: "user", content: `The task:\n${text(messages[0]!)}\n\nThe log:\n${log.slice(-SUMMARIZER_INPUT)}` }],
    abortSignal: signal,
    maxRetries: 2,
  });
  const files = workingSet(worktree, older);
  const summary = [
    "[Artel: your earlier work, summarized to save room. Continue from here.]",
    result.text.trim(),
    files ? `\nCurrent text of the files you changed earlier:\n${files}` : "",
  ].join("\n");
  return { memory: { upTo, summary }, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
}

/** The log as plain text: what the agent said and called, and the start of each result. */
function transcript(messages: ModelMessage[]): string {
  return messages
    .map((m) => {
      if (typeof m.content === "string") return `${m.role}: ${m.content}`;
      return m.content
        .map((part) => {
          if (part.type === "text") return `${m.role}: ${part.text}`;
          if (part.type === "tool-call") return `called ${part.toolName} ${JSON.stringify(part.input).slice(0, 400)}`;
          if (part.type === "tool-result") {
            const out = part.output.type === "text" || part.output.type === "error-text" ? part.output.value : JSON.stringify(part.output);
            return `result of ${part.toolName}: ${out.slice(0, 1500)}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

function text(m: ModelMessage): string {
  return typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

/** The files the summarized work wrote, newest first, as they are now. */
function workingSet(worktree: string, messages: ModelMessage[]): string {
  const paths: string[] = [];
  for (const m of [...messages].reverse()) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const part of m.content) {
      const path = part.type === "tool-call" ? (part.input as { path?: unknown } | null)?.path : undefined;
      if ((part.type === "tool-call" && /^(write_file|edit_file)$/.test(part.toolName)) && typeof path === "string" && !paths.includes(path)) paths.push(path);
    }
  }
  let left = WORKING_SET;
  const shown: string[] = [];
  for (const path of paths) {
    const file = join(worktree, path);
    if (!existsSync(file)) continue;
    const body = readFileSync(file, "utf8");
    if (body.length > left) continue;
    left -= body.length;
    shown.push(`=== ${path} ===\n${body}`);
  }
  return shown.join("\n");
}
