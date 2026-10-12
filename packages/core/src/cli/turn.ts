import { asSchema, type ModelMessage, type ToolSet } from "ai";
import type { RunInput, RunOutcome } from "../agent/run";
import { nowLine } from "../now";
import type { CliId } from "./kinds";
import { runCli } from "./run";

/** A task's step for a command-line agent, with the CLI's session to continue. */
export interface CliTurnInput extends RunInput {
  /** What `onSession` stored last time. */
  session: string | null;
  onSession(stored: string): void;
}

/** A session belongs to one CLI and one model; another model starts a new one. */
export function sessionFor(stored: string | null, preset: string, model: string): string | null {
  if (!stored) return null;
  try {
    const s = JSON.parse(stored) as { preset?: string; model?: string; id?: string };
    return s.preset === preset && s.model === model && s.id ? s.id : null;
  } catch {
    return null;
  }
}

export const storeSession = (preset: string, model: string, id: string) => JSON.stringify({ preset, model, id });

const COMMIT_RULE = [
  "When you are done, end with a short summary in the language of the task: what you changed and how you checked it, 1-4 sentences.",
  "Put a short English commit message in the imperative mood, under 72 characters, on the last line as `COMMIT: <message>`.",
  "Where these instructions say to call finish, end your turn this way instead.",
].join("\n");

function brief(root: string, mode: "read" | "write"): string {
  return [
    "You work inside Artel, a desktop app where AI agents write code under the user's review.",
    `You work in a private copy of the user's project at: ${root}`,
    nowLine(),
    "The user's own folder is not touched until they accept your work.",
    "Never commit, push or change git settings: Artel handles git. Stay inside this folder and install nothing globally.",
    mode === "read" ? "In this step you only read the project: do not change files and do not run commands that change anything." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Earlier turns, for a CLI that starts a new session in the middle of a conversation. */
export function transcript(messages: { role: string; content: unknown }[]): string {
  const lines = messages.flatMap((m) => {
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p: { type?: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : "")).join("")
          : "";
    if (!text.trim() || (m.role !== "user" && m.role !== "assistant")) return [];
    return [`${m.role === "user" ? "User" : "Assistant"}: ${text.trim()}`];
  });
  return lines.length ? `The conversation so far:\n\n${lines.join("\n\n")}` : "";
}

/** The step's result tools, as a JSON answer the CLI must give instead of calling them. */
async function contract(tools: ToolSet, names: string[]): Promise<{ text: string; schema: object }> {
  const options = await Promise.all(
    names.map(async (name) => {
      const t = tools[name]!;
      const schema = await asSchema(t.inputSchema).jsonSchema;
      return `- ${name}: ${t.description ?? ""}\n  input: ${JSON.stringify(schema)}`;
    }),
  );
  return {
    text: [
      'Finish this step with only one JSON object and no other text: {"tool": "<name>", "input": {...}}.',
      "Where these instructions say to call a tool below, answer with this JSON instead. Choose one:",
      ...options,
    ].join("\n"),
    schema: {
      type: "object",
      properties: { tool: { type: "string", enum: names }, input: { type: "object" } },
      required: ["tool", "input"],
      additionalProperties: false,
    },
  };
}

/** The JSON object in an answer, also when it is wrapped in a code block or a sentence. */
export function jsonIn(text: string | null): unknown {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** The summary and the `COMMIT:` line of a final message. */
export function splitCommit(text: string): { summary: string; commitMessage: string | null } {
  const lines = text.trim().split(/\r?\n/);
  const at = lines.findLastIndex((l) => /^\s*`?COMMIT:/i.test(l));
  if (at < 0) return { summary: text.trim(), commitMessage: null };
  const commitMessage = lines[at]!.replace(/^\s*`?COMMIT:\s*/i, "").replace(/`\s*$/, "").trim() || null;
  lines.splice(at, 1);
  return { summary: lines.join("\n").trim(), commitMessage };
}

/** One turn of a command-line agent in a task's step, reported like the agent loop's pass. */
export async function runCliTurn(i: CliTurnInput): Promise<RunOutcome> {
  const preset = i.conn.preset as CliId;
  const resume = sessionFor(i.session, preset, i.model);
  const results = i.mode === "read" ? (i.stopTools ?? []).filter((n) => i.extraTools?.[n]) : [];
  const answer = results.length ? await contract(i.extraTools!, results) : null;
  const last = i.messages.at(-1);
  const prompt = [
    resume ? "" : brief(i.worktree, i.mode),
    i.instructions ?? "",
    resume ? "" : transcript(i.messages.slice(0, -1)),
    typeof last?.content === "string" ? last.content : "",
    answer?.text ?? (i.mode === "write" ? COMMIT_RULE : ""),
  ]
    .filter(Boolean)
    .join("\n\n");

  const names = new Map<string, string>();
  const result = await runCli({
    id: preset,
    cwd: i.worktree,
    prompt,
    model: i.model,
    mode: i.mode,
    web: true,
    resume,
    schema: answer?.schema ?? null,
    signal: i.signal,
    idleTimeoutMs: i.idleTimeoutMs,
    onEvent: (e) => {
      if (e.kind === "call") {
        names.set(e.callId, e.name);
        i.hooks.onCall({ callId: e.callId, name: e.name, input: e.input });
      } else if (e.kind === "result") {
        i.hooks.onResult({ callId: e.callId, name: names.get(e.callId) ?? "tool", ok: e.ok, output: e.output.slice(0, 4000) });
      } else if (e.kind === "text" && i.mode === "write") {
        const shown = splitCommit(e.text).summary;
        if (shown) i.onText(shown);
      }
    },
  });

  if (result.session) i.onSession(storeSession(preset, i.model, result.session));
  const done = result.done;
  if (done) {
    const reply: ModelMessage[] = done.text ? [{ role: "assistant", content: done.text }] : [];
    // A subscription: the tokens are counted, the money is not Artel's to count.
    i.onStep({ messages: reply, inputTokens: done.inputTokens, outputTokens: done.outputTokens, costUsd: 0, priced: true });
  }
  if (result.stopped) return { kind: "stopped" };
  if (result.error || !done) return { kind: "error", error: result.error ?? { code: "provider_error" } };

  if (answer) {
    const picked = (done.structured ?? jsonIn(done.text)) as { tool?: unknown; input?: unknown } | null;
    const t = typeof picked?.tool === "string" && results.includes(picked.tool) ? i.extraTools![picked.tool]! : null;
    if (t?.execute) {
      const checked = await asSchema(t.inputSchema).validate?.(picked!.input);
      if (!checked || checked.success) {
        await t.execute(checked ? checked.value : picked!.input, { toolCallId: "cli", messages: [] } as never);
        return { kind: "finished", summary: "—", commitMessage: null };
      }
      i.onText(`The answer did not match ${String(picked!.tool)}: ${checked.error.message.slice(0, 500)}`);
    } else if (done.text) i.onText(done.text);
    return { kind: "finished", summary: done.text ?? "—", commitMessage: null };
  }
  const { summary, commitMessage } = splitCommit(done.text ?? "");
  return { kind: "finished", summary: summary || "—", commitMessage };
}
