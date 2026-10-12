// A stand-in for Claude Code, Codex and Gemini CLI in tests. It records how it was started, writes the files a
// turn asks for, and prints that turn's events in the real CLI's stream format.
//   node fake-cli.mjs <claude|codex|gemini> [the CLI's own arguments]
// FAKE_CLI_DIR holds script.json (an array of turns) and gets calls.jsonl.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [kind, ...args] = process.argv.slice(2);
const dir = process.env.FAKE_CLI_DIR;
const stdin = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => resolve(data));
});

const state = join(dir, "state.json");
const turnNo = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")).next : 0;
writeFileSync(state, JSON.stringify({ next: turnNo + 1 }));
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ kind, args, prompt: stdin, cwd: process.cwd() }) + "\n");

const turn = JSON.parse(readFileSync(join(dir, "script.json"), "utf8"))[turnNo] ?? { text: "Готово." };
for (const [path, content] of Object.entries(turn.files ?? {})) {
  mkdirSync(dirname(join(process.cwd(), path)), { recursive: true });
  writeFileSync(join(process.cwd(), path), content);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const session = turn.session ?? "sess-1";
const text = turn.json ? JSON.stringify(turn.json) : (turn.text ?? "");

if (kind === "claude") {
  out({ type: "system", subtype: "init", session_id: session, cwd: process.cwd(), tools: ["Read", "Edit", "Bash"] });
  for (const [i, t] of (turn.tools ?? []).entries()) {
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `tu${i}`, name: t.name, input: t.input }] } });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu${i}`, content: t.output ?? "ok", is_error: !!t.error }] } });
  }
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
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
    out({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 30 } });
  }
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
