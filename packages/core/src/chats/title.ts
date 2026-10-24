import { generateText } from "ai";
import { languageModel } from "../providers/model";
import type { Connection } from "../providers/repo";
import { thinkingOptions } from "./thinking";

/** Longest name a chat gets in the list. */
const MAX_TITLE = 48;
/** Longest name made from the first message itself, before the model's comes. */
const MAX_FIRST = 40;

/**
 * The first sentence of the first message, cut at a word (seen live: the whole first message became the chat's name).
 * The chat goes by it until the model names it.
 */
export function shortTitle(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  const sentence = line.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? line;
  return sentence.length > MAX_FIRST ? `${sentence.slice(0, MAX_FIRST).replace(/\s+\S*$/, "")}…` : sentence;
}

/** A name of a few words for a chat, by the chat's own model, in the language of the question; null when it gives none. */
export async function makeTitle(conn: Connection, model: string, question: string, signal?: AbortSignal): Promise<string | null> {
  const { text } = await generateText({
    model: languageModel(conn, model),
    system:
      "Write a title for a chat that starts with the user's message below: 2-5 words, in the language of the message, " +
      "naming its subject like a short headline. Only the title: no quotes, no full stop, no explanation.",
    prompt: question.slice(0, 2000),
    maxOutputTokens: 200,
    providerOptions: thinkingOptions(conn.preset, "off"),
    maxRetries: 0,
    abortSignal: signal ?? AbortSignal.timeout(30_000),
  });
  const title = text
    .trim()
    .split("\n")[0]!
    .replace(/^[\s"'«»“”„`*#]+|[\s"'«»“”„`*.!]+$/g, "")
    .trim();
  if (!title) return null;
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE).replace(/\s+\S*$/, "")}…` : title;
}
