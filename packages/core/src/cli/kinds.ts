import type { SubscriptionLimit } from "@artel/shared";
import { realpathSync } from "node:fs";
import { windowName } from "./limits";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export type CliId = "claude-code" | "codex" | "gemini-cli" | "antigravity";
/** read: look only (interview, spec); write: edit the copy and run safe commands; chat: answer, web at most. */
export type CliMode = "read" | "write" | "chat";

export interface CliLaunch {
  model: string;
  mode: CliMode;
  /** The CLI's own session to continue. */
  resume: string | null;
  /** JSON Schema of the final answer, where the CLI can enforce one. */
  schema: object | null;
  /** Whether the CLI may search and read the web. */
  web: boolean;
}

/** What a CLI's stream means for Drimvox, whichever CLI it came from. */
export type CliEvent =
  | { kind: "session"; id: string; /** The model the CLI runs, when it says. */ model?: string }
  | { kind: "text"; text: string }
  | { kind: "call"; callId: string; name: string; input: Record<string, unknown> }
  | { kind: "result"; callId: string; ok: boolean; output: string }
  | { kind: "limit"; limit: SubscriptionLimit }
  | { kind: "done"; text: string | null; structured: unknown; inputTokens: number; outputTokens: number; error: string | null };

export interface CliKind {
  args(l: CliLaunch): string[];
  /** What goes to its input: the prompt as it is, unless the CLI wants it wrapped. */
  input?(prompt: string): string;
  /** One parser per run: some CLIs spread the answer over several lines. */
  parser(cwd: string): (line: Record<string, unknown>) => CliEvent[];
}

const SAFE_READ = ["Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch"];

/** Never without the user: pushing, installing for the whole system, downloading, acting as administrator. */
const DANGEROUS = [
  "git push",
  "npm install -g",
  "npm i -g",
  "npm uninstall -g",
  "pnpm add -g",
  "yarn global",
  "curl",
  "wget",
  "sudo",
  "Invoke-WebRequest",
  "Invoke-RestMethod",
  "iwr",
  "irm",
  "Start-Process",
];

/** Their tools, in the words of Drimvox's feed. */
function mapTool(name: string, input: Record<string, unknown>, cwd: string): { name: string; input: Record<string, unknown> } {
  const path = (p: unknown) => (typeof p === "string" ? shorten(p, cwd) : "");
  switch (name) {
    case "Read":
    case "read_file":
    case "read_many_files":
      return { name: "read_file", input: { path: path(input.file_path ?? input.absolute_path ?? input.path) } };
    case "Write":
    case "write_file":
      return { name: "write_file", input: { path: path(input.file_path ?? input.path) } };
    case "Edit":
    case "MultiEdit":
    case "replace":
      return { name: "edit_file", input: { path: path(input.file_path ?? input.path) } };
    case "Bash":
    case "PowerShell":
    case "run_shell_command":
    case "command":
      return { name: "run_command", input: { command: String(input.command ?? "") } };
    case "Grep":
    case "search_file_content":
      return { name: "search", input: { pattern: String(input.pattern ?? "") } };
    case "Glob":
    case "LS":
    case "glob":
    case "list_directory":
      return { name: "list_files", input: { path: String(input.pattern ?? path(input.path ?? input.dir_path) ?? ".") } };
    case "WebSearch":
    case "google_web_search":
      return { name: "web_search", input: { query: String(input.query ?? "") } };
    case "WebFetch":
    case "web_fetch":
      return { name: "open_page", input: { url: String(input.url ?? input.prompt ?? "") } };
    default:
      return { name, input };
  }
}

function shorten(p: string, cwd: string): string {
  if (!isAbsolute(p)) return p.split(sep).join("/");
  const rel = relative(cwd, longPath(p));
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : p;
}

/**
 * A path under its full name. Windows temp folders often come as 8.3 short names (C:\Users\12C2~1\…): Claude Code
 * then counts files of its own folder as outside it, and paths in the feed stop matching the copy.
 * A file about to be created has no full name yet; its folder does.
 */
export function longPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    try {
      return join(realpathSync.native(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

const text = (v: unknown): string =>
  typeof v === "string" ? v : Array.isArray(v) ? v.map((x) => (typeof x === "object" && x && "text" in x ? String((x as { text: unknown }).text) : "")).join("\n") : "";

/** What Claude Code may use without asking when it only reads; everything else is refused. */
function readTools(l: CliLaunch): string[] {
  const tools = [...(l.mode === "read" ? SAFE_READ.slice(0, 4) : []), ...(l.web ? ["WebSearch", "WebFetch"] : [])];
  return tools.length ? ["--allowedTools", ...tools] : [];
}

const claude: CliKind = {
  args: (l) => {
    const perms =
      l.mode === "write"
        ? [
            "--permission-mode",
            "acceptEdits",
            "--allowedTools",
            "Bash",
            "PowerShell",
            "Edit",
            "MultiEdit",
            "Write",
            ...SAFE_READ,
            "--disallowedTools",
            ...DANGEROUS.flatMap((c) => [`Bash(${c}:*)`, `PowerShell(${c}:*)`]),
          ]
        : ["--permission-mode", "dontAsk", ...readTools(l)];
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(l.model !== "default" ? ["--model", l.model] : []),
      ...(l.resume ? ["--resume", l.resume] : []),
      ...perms,
      ...(l.schema ? ["--json-schema", JSON.stringify(l.schema)] : []),
    ];
  },
  parser: (cwd) => {
    // The JSON answer arrives through Claude Code's own StructuredOutput tool: not work to show in the feed.
    const hidden = new Set<string>();
    return (e) => {
      const out: CliEvent[] = [];
      if (e.type === "system" && e.subtype === "init" && typeof e.session_id === "string") {
        out.push({ kind: "session", id: e.session_id, ...(typeof e.model === "string" ? { model: e.model } : {}) });
      }
      const content = (e.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const c of content as Record<string, unknown>[]) {
        if (e.type === "assistant" && c.type === "text" && typeof c.text === "string" && c.text) out.push({ kind: "text", text: c.text });
        if (e.type === "assistant" && c.type === "tool_use" && c.name === "StructuredOutput") hidden.add(String(c.id));
        else if (e.type === "assistant" && c.type === "tool_use") {
          const t = mapTool(String(c.name), (c.input ?? {}) as Record<string, unknown>, cwd);
          out.push({ kind: "call", callId: String(c.id), ...t });
        }
        if (e.type === "user" && c.type === "tool_result" && !hidden.has(String(c.tool_use_id))) {
          out.push({ kind: "result", callId: String(c.tool_use_id), ok: !c.is_error, output: text(c.content) });
        }
      }
      if (e.type === "rate_limit_event") {
        const info = (e.rate_limit_info ?? {}) as { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number };
        out.push({
          kind: "limit",
          limit: {
            window: info.rateLimitType ?? "other",
            usedShare: typeof info.utilization === "number" ? info.utilization : null,
            resetsAt: typeof info.resetsAt === "number" ? info.resetsAt * 1000 : null,
            status: info.status === "allowed" ? "ok" : info.status === "allowed_warning" ? "warning" : "reached",
          },
        });
      }
      if (e.type === "result") {
        const usage = (e.usage ?? {}) as Record<string, number>;
        const failed = e.is_error === true || (typeof e.subtype === "string" && e.subtype !== "success");
        out.push({
          kind: "done",
          text: failed ? null : text(e.result),
          structured: e.structured_output ?? null,
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          error: failed ? text(e.result) || String(e.subtype) : null,
        });
      }
      return out;
    };
  },
};

interface CodexWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
  resets_in_seconds?: number;
}

const codex: CliKind = {
  args: (l) => [
    "exec",
    "--json",
    "--skip-git-repo-check",
    // Writes only inside the copy and no network; reading only on the read steps and in chats.
    "--sandbox",
    l.mode === "write" ? "workspace-write" : "read-only",
    ...(l.model !== "default" ? ["-m", l.model] : []),
    ...(l.resume ? ["resume", l.resume] : []),
    "-",
  ],
  parser: (cwd) => {
    let last: string | null = null;
    let failure: string | null = null;
    return (e) => {
      const out: CliEvent[] = [];
      const item = (e.item ?? {}) as Record<string, unknown>;
      if (e.type === "thread.started" && typeof e.thread_id === "string") out.push({ kind: "session", id: e.thread_id });
      // Codex reports its windows in percent, the window in minutes; where it says so is not stable, so any event counts.
      const limits = (e.rate_limits ?? (e.msg as { rate_limits?: unknown } | undefined)?.rate_limits) as Record<string, CodexWindow | null> | undefined;
      for (const w of Object.values(limits ?? {})) {
        if (!w || typeof w.used_percent !== "number") continue;
        const resets = typeof w.resets_at === "number" ? w.resets_at * 1000 : typeof w.resets_in_seconds === "number" ? Date.now() + w.resets_in_seconds * 1000 : null;
        const used = w.used_percent / 100;
        out.push({ kind: "limit", limit: { window: windowName(w.window_minutes), usedShare: used, resetsAt: resets, status: used >= 1 ? "reached" : used >= 0.8 ? "warning" : "ok" } });
      }
      if (e.type === "item.started" && item.type === "command_execution") {
        out.push({ kind: "call", callId: String(item.id), name: "run_command", input: { command: String(item.command ?? "") } });
      }
      if (e.type === "item.completed" && item.type === "command_execution") {
        out.push({ kind: "result", callId: String(item.id), ok: item.exit_code === 0, output: String(item.aggregated_output ?? "") });
      }
      if (e.type === "item.completed" && item.type === "file_change") {
        for (const [i, c] of ((item.changes ?? []) as { path: string }[]).entries()) {
          const callId = `${String(item.id)}-${i}`;
          out.push({ kind: "call", callId, name: "edit_file", input: { path: shorten(c.path, cwd) } });
          out.push({ kind: "result", callId, ok: item.status !== "failed", output: "" });
        }
      }
      if (e.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
        last = item.text;
        out.push({ kind: "text", text: item.text });
      }
      if (e.type === "turn.failed") failure = String((e.error as { message?: string } | undefined)?.message ?? "Codex failed");
      if (e.type === "turn.completed" || e.type === "turn.failed") {
        const usage = (e.usage ?? {}) as Record<string, number>;
        out.push({ kind: "done", text: failure ? null : last, structured: null, inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, error: failure });
      }
      return out;
    };
  },
};

/** Commands Gemini CLI may run without asking; everything else is refused in headless mode. */
const GEMINI_SAFE = ["npm test", "npm run", "npx vitest", "npx tsc", "node", "pytest", "python -m pytest", "git status", "git diff", "git log"];

const gemini: CliKind = {
  args: (l) => [
    "--output-format",
    "stream-json",
    ...(l.model !== "default" ? ["-m", l.model] : []),
    ...(l.resume ? ["--resume", l.resume] : []),
    "--approval-mode",
    l.mode === "write" ? "auto_edit" : "default",
    ...(l.mode === "write" ? GEMINI_SAFE.flatMap((c) => ["--allowed-tools", `run_shell_command(${c})`]) : []),
  ],
  parser: (cwd) => {
    let answer = "";
    // The answer arrives in pieces; it goes to the feed whole, before the next tool or at the end.
    let pending = "";
    return (e) => {
      const out: CliEvent[] = [];
      if (e.type === "init" && typeof e.session_id === "string") {
        out.push({ kind: "session", id: e.session_id, ...(typeof e.model === "string" ? { model: e.model } : {}) });
      }
      if (e.type === "message" && e.role === "assistant" && typeof e.content === "string") {
        answer = e.delta ? answer + e.content : e.content;
        pending = e.delta ? pending + e.content : e.content;
      }
      if ((e.type === "tool_use" || e.type === "result") && pending.trim()) {
        out.push({ kind: "text", text: pending.trim() });
        pending = "";
      }
      if (e.type === "tool_use") {
        const t = mapTool(String(e.tool_name), (e.parameters ?? {}) as Record<string, unknown>, cwd);
        out.push({ kind: "call", callId: String(e.tool_id), ...t });
      }
      if (e.type === "tool_result") {
        const err = e.error as { message?: string } | undefined;
        out.push({ kind: "result", callId: String(e.tool_id), ok: e.status === "success", output: String(e.output ?? err?.message ?? "") });
      }
      if (e.type === "result") {
        const stats = (e.stats ?? {}) as Record<string, number>;
        const failed = e.status !== "success";
        out.push({
          kind: "done",
          text: failed ? null : answer,
          structured: null,
          inputTokens: stats.input_tokens ?? 0,
          outputTokens: stats.output_tokens ?? 0,
          error: failed ? String((e.error as { message?: string } | undefined)?.message ?? "Gemini CLI failed") : null,
        });
      }
      return out;
    };
  },
};


/**
 * Antigravity CLI (`agy`), Google's successor to Gemini CLI for personal accounts. Headless: the prompt goes in as a
 * stream-json "user" line (long prompts do not fit an argument on Windows), every output line names its "event".
 * Without --dangerously-skip-permissions it asks for nothing and quietly refuses what needs approval: chats and read
 * steps stay read-only that way. Writing steps run in Drimvox's copy of the project, with agy's terminal sandbox on.
 */
const antigravity: CliKind = {
  args: (l) => [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--print-timeout",
    "60m",
    ...(l.model !== "default" ? ["--model", l.model] : []),
    ...(l.resume ? ["--conversation", l.resume] : []),
    ...(l.mode === "write" ? ["--dangerously-skip-permissions", "--sandbox"] : []),
    ...(l.schema ? ["--json-schema", JSON.stringify(l.schema)] : []),
  ],
  input: (prompt) => `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`,
  parser: (cwd) => {
    let session: string | null = null;
    // The answer of a step comes in deltas; it goes to the feed whole when the step is done.
    const answers = new Map<number, string>();
    return (e) => {
      const out: CliEvent[] = [];
      const step = (e.step_update ?? {}) as Record<string, unknown>;
      const conversation = (e.conversation_id ?? step.conversation_id ?? (e.result as { conversation_id?: unknown } | undefined)?.conversation_id) as unknown;
      if (!session && typeof conversation === "string") {
        session = conversation;
        const model = (e.init as { model?: unknown } | undefined)?.model;
        out.push({ kind: "session", id: conversation, ...(typeof model === "string" ? { model } : {}) });
      }
      if (e.event === "step_update" && step.step_type === "agent_response") {
        const index = Number(step.step_index);
        if (typeof step.text_delta === "string") answers.set(index, (answers.get(index) ?? "") + step.text_delta);
        if (step.state === "DONE" && answers.get(index)?.trim()) out.push({ kind: "text", text: answers.get(index)!.trim() });
      }
      if (e.event === "step_update" && step.step_type === "tool") {
        const info = (step.tool_info ?? {}) as { name?: string; parameters?: Record<string, unknown>; output?: unknown; error?: { message?: string } };
        const callId = `step-${String(step.step_index)}`;
        if (step.state === "ACTIVE") out.push({ kind: "call", callId, ...mapTool(String(info.name ?? step.tool_name), info.parameters ?? {}, cwd) });
        if (step.state === "DONE") out.push({ kind: "result", callId, ok: !info.error, output: text(info.output) || (info.error?.message ?? "") });
      }
      if (e.event === "result") {
        const r = (e.result ?? {}) as { status?: string; response?: string; error?: string; structured_output?: unknown; usage?: Record<string, number> };
        const failed = r.status !== "SUCCESS";
        out.push({
          kind: "done",
          text: failed ? null : (r.response ?? ""),
          structured: r.structured_output ?? null,
          inputTokens: (r.usage?.input_tokens ?? 0) + (r.usage?.cache_read_tokens ?? 0),
          outputTokens: (r.usage?.output_tokens ?? 0) + (r.usage?.thinking_tokens ?? 0),
          error: failed ? r.error || `Antigravity CLI ended with ${r.status ?? "no status"}` : null,
        });
      }
      return out;
    };
  },
};

export const CLI_KINDS: Record<CliId, CliKind> = { "claude-code": claude, codex, "gemini-cli": gemini, antigravity };

export function isCli(preset: string): preset is CliId {
  return preset in CLI_KINDS;
}
