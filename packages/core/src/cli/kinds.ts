import { isAbsolute, relative, sep } from "node:path";

export type CliId = "claude-code" | "codex" | "gemini-cli";
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

/** What a CLI's stream means for Artel, whichever CLI it came from. */
export type CliEvent =
  | { kind: "session"; id: string }
  | { kind: "text"; text: string }
  | { kind: "call"; callId: string; name: string; input: Record<string, unknown> }
  | { kind: "result"; callId: string; ok: boolean; output: string }
  | { kind: "done"; text: string | null; structured: unknown; inputTokens: number; outputTokens: number; error: string | null };

export interface CliKind {
  models: string[];
  args(l: CliLaunch): string[];
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

/** Their tools, in the words of Artel's feed. */
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
  const rel = relative(cwd, p);
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : p;
}

const text = (v: unknown): string =>
  typeof v === "string" ? v : Array.isArray(v) ? v.map((x) => (typeof x === "object" && x && "text" in x ? String((x as { text: unknown }).text) : "")).join("\n") : "";

/** What Claude Code may use without asking when it only reads; everything else is refused. */
function readTools(l: CliLaunch): string[] {
  const tools = [...(l.mode === "read" ? SAFE_READ.slice(0, 4) : []), ...(l.web ? ["WebSearch", "WebFetch"] : [])];
  return tools.length ? ["--allowedTools", ...tools] : [];
}

const claude: CliKind = {
  models: ["default", "haiku", "opus", "sonnet"],
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
  parser: (cwd) => (e) => {
    const out: CliEvent[] = [];
    if (e.type === "system" && e.subtype === "init" && typeof e.session_id === "string") out.push({ kind: "session", id: e.session_id });
    const content = (e.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const c of content as Record<string, unknown>[]) {
      if (e.type === "assistant" && c.type === "text" && typeof c.text === "string" && c.text) out.push({ kind: "text", text: c.text });
      if (e.type === "assistant" && c.type === "tool_use") {
        const t = mapTool(String(c.name), (c.input ?? {}) as Record<string, unknown>, cwd);
        out.push({ kind: "call", callId: String(c.id), ...t });
      }
      if (e.type === "user" && c.type === "tool_result") out.push({ kind: "result", callId: String(c.tool_use_id), ok: !c.is_error, output: text(c.content) });
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
  },
};

const codex: CliKind = {
  models: ["default"],
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
  models: ["default", "flash", "flash-lite", "pro"],
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
      if (e.type === "init" && typeof e.session_id === "string") out.push({ kind: "session", id: e.session_id });
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

export const CLI_KINDS: Record<CliId, CliKind> = { "claude-code": claude, codex, "gemini-cli": gemini };

export function isCli(preset: string): preset is CliId {
  return preset in CLI_KINDS;
}
