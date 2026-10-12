import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ReplyInput } from "../chats/reply";
import { nowLine } from "../now";
import type { CliId } from "./kinds";
import { runCli } from "./run";
import { sessionFor, storeSession, transcript } from "./turn";

/**
 * A chat answer from a command-line agent. It runs in the chat's own empty folder, reads nothing of the
 * user's and changes nothing; the web only when the chat allows it. The CLI keeps the conversation in its session.
 */
export async function cliReply(i: ReplyInput, dir: string, formatHint: string): Promise<void> {
  const userMessage = i.chats.addMessage({ chatId: i.chatId, role: "user", content: i.content, status: "done" });
  i.chats.nameIfUntitled(i.chatId, i.content);
  const history = i.chats.history(i.chatId);
  const answer = i.chats.addMessage({ chatId: i.chatId, role: "assistant", content: "", status: "streaming", providerId: i.conn.id, model: i.model });
  await i.emit({ type: "start", userMessage, assistantMessageId: answer.id });

  const preset = i.conn.preset as CliId;
  const resume = sessionFor(i.chats.cliSession(i.chatId), preset, i.model);
  const cwd = join(dir, i.chatId);
  mkdirSync(cwd, { recursive: true });
  const prompt = resume
    ? i.content
    : [nowLine(), formatHint, "You are chatting with the user inside Artel. Answer in the user's language.", transcript(history.slice(0, -1)), i.content]
        .filter(Boolean)
        .join("\n\n");

  let text = "";
  const result = await runCli({
    id: preset,
    cwd,
    prompt,
    model: i.model,
    mode: "chat",
    web: i.web !== "off",
    resume,
    schema: null,
    signal: i.signal,
    idleTimeoutMs: i.idleTimeoutMs,
    onEvent: (e) => {
      if (e.kind === "text") {
        const piece = text ? `\n\n${e.text}` : e.text;
        text += piece;
        void i.emit({ type: "text", text: piece });
      } else if (e.kind === "call") {
        void i.emit({ type: "tool", name: e.name, input: JSON.stringify(e.input) });
      }
    },
  });
  if (result.session) i.chats.setCliSession(i.chatId, storeSession(preset, i.model, result.session));

  const stopped = result.stopped;
  // A CLI that is not logged in says so as its answer too; the error note says it once.
  const echo = result.error && result.done?.error && text.trim() === result.done.error.trim();
  const message = i.chats.finishAnswer(answer.id, {
    content: echo ? "" : text,
    reasoning: null,
    status: stopped ? "stopped" : result.error ? "error" : "done",
    inputTokens: result.done?.inputTokens ?? null,
    outputTokens: result.done?.outputTokens ?? null,
    // Paid for by the user's subscription to the CLI.
    costUsd: result.done ? 0 : null,
    error: stopped ? null : result.error,
  });
  if (!stopped) await i.emit({ type: "done", message });
}
