import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { classifyCommand, runCommand, type CommandVerdict } from "./commands";
import type { Workspace } from "./workspace";

export interface ToolHooks {
  onCall(call: { callId: string; name: string; input: unknown }): void;
  onResult(result: { callId: string; name: string; ok: boolean; output: string }): void;
  /** Resolves true when the user allows the command. */
  askApproval(command: string, reason: Extract<CommandVerdict, { action: "ask" }>["reason"], signal?: AbortSignal): Promise<boolean>;
  onFinish(result: { summary: string; commitMessage: string }): void;
}

const OUTPUT_FOR_EVENTS = 4000;

type Run<S extends z.ZodType> = (input: z.infer<S>, signal?: AbortSignal) => Promise<{ ok: boolean; output: string }>;

/**
 * The agent's tools, bound to one task's copy of the project. "read" mode, for the interview and
 * the spec, leaves out everything that changes files or runs commands.
 */
export function buildTools(ws: Workspace, hooks: ToolHooks, mode: "read" | "write" = "write", extra: ToolSet = {}): ToolSet {
  function wrap<S extends z.ZodType>(name: string, description: string, inputSchema: S, run: Run<S>) {
    return tool({
      description,
      inputSchema,
      execute: async (input: z.infer<S>, options: { toolCallId: string; abortSignal?: AbortSignal }) => {
        hooks.onCall({ callId: options.toolCallId, name, input });
        let result: { ok: boolean; output: string };
        try {
          result = await run(input, options.abortSignal);
        } catch (err) {
          result = { ok: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
        }
        hooks.onResult({ callId: options.toolCallId, name, ok: result.ok, output: clip(result.output) });
        return result.output;
      },
    });
  }

  const ok = (output: string) => ({ ok: true, output });

  const readTools: ToolSet = {
    list_files: wrap(
      "list_files",
      "List files and folders (folders end with /). Skips .git, node_modules and build output.",
      z.object({ path: z.string().default("."), depth: z.number().int().min(1).max(5).default(2) }),
      async ({ path, depth }) => ok(ws.listFiles(path, depth).join("\n") || "(empty)"),
    ),
    read_file: wrap(
      "read_file",
      "Read a text file. Lines are prefixed with their numbers. Use offset/limit for long files.",
      z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(2000).optional() }),
      async ({ path, offset, limit }) => ok(ws.readFile(path, offset, limit)),
    ),
    search: wrap(
      "search",
      "Search file contents with a regular expression. Returns path:line: text, at most 100 matches.",
      z.object({ pattern: z.string().min(1), path: z.string().default(".") }),
      async ({ pattern, path }) => ok(ws.search(pattern, path).join("\n") || "No matches."),
    ),
  };

  // Step tools (ask_questions, propose_spec) show up in the feed like any other call.
  const stepTools: ToolSet = {};
  for (const [name, t] of Object.entries(extra)) {
    const description = typeof t.description === "string" ? t.description : name;
    stepTools[name] = wrap(name, description, t.inputSchema as z.ZodType, async (input) =>
      ok(String(await t.execute!(input as never, { toolCallId: "", messages: [] } as never))),
    );
  }

  if (mode === "read") return { ...readTools, ...stepTools };

  return {
    ...readTools,
    ...stepTools,
    write_file: wrap(
      "write_file",
      "Create or overwrite a file with the full content. Creates missing folders.",
      z.object({ path: z.string(), content: z.string() }),
      async ({ path, content }) => {
        ws.writeFile(path, content);
        return ok(`Wrote ${path}`);
      },
    ),
    edit_file: wrap(
      "edit_file",
      "Replace one exact fragment of a file. `old` must appear exactly once; include surrounding lines to make it unique.",
      z.object({ path: z.string(), old: z.string().min(1), new: z.string() }),
      async ({ path, old, new: replacement }) => {
        ws.editFile(path, old, replacement);
        return ok(`Edited ${path}`);
      },
    ),
    run_command: wrap(
      "run_command",
      "Run a shell command in the project folder, e.g. tests or a build. Returns the exit code and the end of the output.",
      z.object({ command: z.string().min(1), timeout_seconds: z.number().int().min(1).max(600).default(120) }),
      async ({ command, timeout_seconds }, signal) => {
        const verdict = classifyCommand(command, ws.root);
        if (verdict.action === "ask" && !(await hooks.askApproval(command, verdict.reason, signal))) {
          return { ok: false, output: "The user denied this command. Do not retry it; find another way or explain in finish." };
        }
        const result = await runCommand(command, ws.root, timeout_seconds * 1000, signal);
        const head = result.timedOut ? `Timed out after ${timeout_seconds}s` : `Exit code: ${result.exitCode}`;
        return { ok: result.exitCode === 0 && !result.timedOut, output: `${head}\n${result.output}` };
      },
    ),
    finish: wrap(
      "finish",
      "Call once when the task is done (or cannot be done).",
      z.object({ summary: z.string().min(1), commit_message: z.string().min(1).max(200) }),
      async ({ summary, commit_message }) => {
        hooks.onFinish({ summary, commitMessage: commit_message.split("\n")[0]!.trim() });
        return ok("Finished.");
      },
    ),
  };
}

function clip(text: string): string {
  return text.length > OUTPUT_FOR_EVENTS ? `${text.slice(0, OUTPUT_FOR_EVENTS)}\n…` : text;
}
