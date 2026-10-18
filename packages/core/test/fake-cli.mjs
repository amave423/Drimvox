// A stand-in for Claude Code, Codex and Gemini CLI in tests. It records how it was started, writes the files a
// turn asks for, and prints that turn's events in the real CLI's stream format.
//   node fake-cli.mjs <claude|codex|gemini> [the CLI's own arguments]
// FAKE_CLI_DIR holds script.json (an array of turns) and gets calls.jsonl.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [kind, ...args] = process.argv.slice(2);
const dir = process.env.FAKE_CLI_DIR;
// `agy models` lists the slugs, one per line, under a header.
if (kind === "agy" && args[0] === "models") {
  process.stdout.write(["Available models:", "  gemini-4-argon        Gemini 4 Argon", "  gemini-3.8-flash      Gemini 3.8 Flash", "  claude-sonnet-5-5     Claude Sonnet 5.5", ""].join("\n"));
  process.exit(0);
}
const stdin = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => resolve(data));
});

const state = join(dir, "state.json");
const turnNo = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")).next : 0;
writeFileSync(state, JSON.stringify({ next: turnNo + 1 }));
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ kind, args, prompt: stdin, cwd: process.cwd(), proxy: process.env.HTTPS_PROXY ?? null }) + "\n");

const turn = JSON.parse(readFileSync(join(dir, "script.json"), "utf8"))[turnNo] ?? { text: "Готово." };
for (const [path, content] of Object.entries(turn.files ?? {})) {
  mkdirSync(dirname(join(process.cwd(), path)), { recursive: true });
  writeFileSync(join(process.cwd(), path), content);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const session = turn.session ?? "sess-1";
const text = turn.json ? JSON.stringify(turn.json) : (turn.text ?? "");

if (kind === "claude") {
  out({ type: "system", subtype: "init", session_id: session, cwd: process.cwd(), tools: ["Read", "Edit", "Bash"], model: turn.initModel ?? "claude-test-1" });
  for (const [i, t] of (turn.tools ?? []).entries()) {
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `tu${i}`, name: t.name, input: t.input }] } });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu${i}`, content: t.output ?? "ok", is_error: !!t.error }] } });
  }
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  // Claude Code tells how much of the subscription's window is used (seen live: seven_day, utilization 0.35).
  for (const l of turn.limits ?? []) out({ type: "rate_limit_event", rate_limit_info: l });
  out({
    type: "result",
    subtype: turn.error ? "error_during_execution" : "success",
    is_error: !!turn.error,
    result: turn.error ?? text,
    ...(turn.json ? { structured_output: turn.json } : {}),
    session_id: session,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0 },
  });
} else if (kind === "codex") {
  out({ type: "thread.started", thread_id: session });
  out({ type: "turn.started" });
  for (const [i, t] of (turn.tools ?? []).entries()) {
    if (t.name === "command") {
      out({ type: "item.started", item: { id: `i${i}`, type: "command_execution", command: t.input.command, aggregated_output: "", exit_code: null, status: "in_progress" } });
      out({ type: "item.completed", item: { id: `i${i}`, type: "command_execution", command: t.input.command, aggregated_output: t.output ?? "", exit_code: t.error ? 1 : 0, status: t.error ? "failed" : "completed" } });
    } else {
      out({ type: "item.completed", item: { id: `i${i}`, type: "file_change", changes: [{ path: join(process.cwd(), t.input.path), kind: "update" }], status: "completed" } });
    }
  }
  if (turn.error) out({ type: "turn.failed", error: { message: turn.error } });
  else {
    out({ type: "item.completed", item: { id: "final", type: "agent_message", text } });
    if (turn.rateLimits) out({ type: "token_count", rate_limits: turn.rateLimits });
    out({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 30 } });
  }
} else if (kind === "agy") {
  // Antigravity CLI: every line names its event; text comes in deltas, tools as steps.
  const step = (o) => out({ event: "step_update", step_update: { conversation_id: session, ...o } });
  out({ event: "init", conversation_id: session, init: { cwd: process.cwd(), tools: ["read_file", "write_file", "command"], permission_mode: "request-review" } });
  step({ step_index: 0, state: "DONE", step_type: "user_input" });
  for (const [i, t] of (turn.tools ?? []).entries()) {
    step({ step_index: i + 1, state: "ACTIVE", step_type: "tool", tool_name: t.name, tool_info: { name: t.name, parameters: t.input } });
    step({ step_index: i + 1, state: "DONE", step_type: "tool", tool_name: t.name, tool_info: { name: t.name, parameters: t.input, output: t.output ?? "ok", ...(t.error ? { error: { type: "Error", message: "failed" } } : {}) } });
  }
  const n = (turn.tools ?? []).length + 1;
  step({ step_index: n, state: "ACTIVE", step_type: "agent_response", text_delta: text.slice(0, 3) });
  step({ step_index: n, state: "ACTIVE", step_type: "agent_response", text_delta: text.slice(3) });
  step({ step_index: n, state: "DONE", step_type: "agent_response" });
  out({
    event: "result",
    result: {
      conversation_id: session,
      status: turn.error ? "ERROR" : "SUCCESS",
      response: turn.error ? "" : text,
      ...(turn.error ? { error: turn.error } : {}),
      ...(turn.json ? { structured_output: turn.json } : {}),
      usage: { input_tokens: 120, output_tokens: 30, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 155 },
    },
  });
} else {
  out({ type: "init", timestamp: "t", session_id: session, model: "gemini-test" });
  for (const [i, t] of (turn.tools ?? []).entries()) {
    out({ type: "tool_use", timestamp: "t", tool_name: t.name, tool_id: `g${i}`, parameters: t.input });
    out({ type: "tool_result", timestamp: "t", tool_id: `g${i}`, status: t.error ? "error" : "success", output: t.output ?? "ok" });
  }
  out({ type: "message", timestamp: "t", role: "assistant", content: text, delta: true });
  out({
    type: "result",
    timestamp: "t",
    status: turn.error ? "error" : "success",
    ...(turn.error ? { error: { type: "Error", message: turn.error } } : {}),
    stats: { total_tokens: 150, input_tokens: 120, output_tokens: 30, cached: 0, input: 120, duration_ms: 5, tool_calls: 0, models: {} },
  });
}
process.exit(turn.error ? 1 : 0);
