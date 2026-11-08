import { tool, type Tool, type ToolSet } from "ai";
import { Worker } from "node:worker_threads";
import { z } from "zod";

/** The longest a piece of code may run, its tools' time included. */
const CODE_MS = 15 * 60_000;
/** The most of its logs and value the model gets back. */
const RESULT_LIMIT = 30_000;

/**
 * The code runs in a worker of its own: another heap, so nothing of Drimvox's memory (the providers' keys, decrypted)
 * is within its reach; no environment, no `require`. Its tools are the agent's own, called back over messages, so each
 * call shows in the feed and asks the user where it always asks.
 */
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const pending = new Map();
let next = 0;
parentPort.on("message", (m) => {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.ok ? p.resolve(m.value) : p.reject(new Error(m.value));
});
const tools = new Proxy({}, {
  get: (_, name) => (args = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      parentPort.postMessage({ type: "call", id, name: String(name), args });
    }),
});
const logs = [];
const show = (v) => (typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());
const console = { log: (...a) => logs.push(a.map(show).join(" ")), info: (...a) => logs.push(a.map(show).join(" ")), warn: (...a) => logs.push("warn: " + a.map(show).join(" ")), error: (...a) => logs.push("error: " + a.map(show).join(" ")) };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction("tools", "console", "process", "require", workerData.code);
run(tools, console, undefined, undefined).then(
  (value) => parentPort.postMessage({ type: "done", logs, value: value === undefined ? null : value }),
  (err) => parentPort.postMessage({ type: "error", logs, message: String((err && err.stack) || err) }),
);
`;

/** What a tool gave back, as text the code and the model can read. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const clip = (text: string) => (text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}\n… (cut at ${RESULT_LIMIT} characters)` : text);

/**
 * Many actions in one step (asked for: as OpenCode's Code Mode): the model writes a piece of JavaScript that calls its
 * other tools in order, in loops and with conditions, and gets back only what the code logs and returns. Each step sends
 * the whole conversation to the model again; ten reads in one step cost one round, not ten.
 */
export function codeTool(tools: () => ToolSet, skip: string[]): Tool {
  const names = () => Object.keys(tools()).filter((n) => n !== "execute" && !skip.includes(n));
  return tool({
    description:
      "Run JavaScript, the body of an async function, that calls your other tools as `await tools.name({ ...args })`: many " +
      "actions in one step, with loops and conditions (read several files and edit them, run a command and look at the " +
      "page, check a list of things). Each call returns what the tool returns as text, and shows in the user's feed as a " +
      "normal call. console.log what you need to see and return a value; only that comes back to you. Use it for three " +
      "or more actions that need no thinking between them; call the tools directly otherwise. No require, no process: " +
      "everything goes through tools.",
    inputSchema: z.object({ code: z.string().min(1).max(50_000).describe("The body of an async function; `tools` and `console` are given") }),
    execute: ({ code }, o: { toolCallId?: string; abortSignal?: AbortSignal }) =>
      new Promise<string>((resolve) => {
        const allowed = new Set(names());
        const worker = new Worker(WORKER, { eval: true, env: {}, workerData: { code }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
        let calls = 0;
        let settled = false;
        const end = (text: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          o.abortSignal?.removeEventListener("abort", onAbort);
          void worker.terminate();
          resolve(clip(text));
        };
        const onAbort = () => end("Stopped.");
        const timer = setTimeout(() => end(`The code ran past ${CODE_MS / 60_000} minutes and was stopped.`), CODE_MS);
        o.abortSignal?.addEventListener("abort", onAbort);
        worker.on("message", async (m: { type: string; id?: number; name?: string; args?: unknown; logs?: string[]; value?: unknown; message?: string }) => {
          if (m.type === "call") {
            const name = m.name ?? "";
            const t = tools()[name];
            if (!allowed.has(name) || !t?.execute) {
              worker.postMessage({ id: m.id, ok: false, value: `No tool "${name}". Tools: ${[...allowed].join(", ")}` });
              return;
            }
            try {
              const value = await t.execute(m.args as never, { toolCallId: `${o.toolCallId ?? "execute"}-${++calls}`, messages: [], abortSignal: o.abortSignal } as never);
              worker.postMessage({ id: m.id, ok: true, value: textOf(value) });
            } catch (err: unknown) {
              worker.postMessage({ id: m.id, ok: false, value: err instanceof Error ? err.message : String(err) });
            }
            return;
          }
          const logs = (m.logs ?? []).join("\n");
          if (m.type === "done") end([logs, m.value === null ? "" : `Returned: ${textOf(m.value)}`].filter(Boolean).join("\n") || "(done, nothing logged)");
          else end([logs, `Error: ${m.message ?? "unknown"}`].filter(Boolean).join("\n"));
        });
        worker.on("error", (err: Error) => end(`Error: ${err.message}`));
        worker.on("exit", () => end("The code ended without a result."));
      }),
  });
}
