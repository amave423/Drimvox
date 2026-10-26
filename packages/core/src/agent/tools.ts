import { writeNotes } from "./notes";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { classifyCommand, runCommand, type CommandVerdict } from "./commands";
import type { Workspace } from "./workspace";
import type { ApprovalAnswer } from "./approvals";

/** Why an agent needs the user's permission: a risky command or a dear picture. */
export type ApprovalReason = Extract<CommandVerdict, { action: "ask" }>["reason"] | "media_cost" | "mcp";

export interface ToolHooks {
  onCall(call: { callId: string; name: string; input: unknown }): void;
  onResult(result: { callId: string; name: string; ok: boolean; output: string }): void;
  /** Resolves true when the user allows the command. */
  /** Resolves true when the user allows it once, "always" when for good (MCP tools), false when not. */
  askApproval(command: string, reason: ApprovalReason, signal?: AbortSignal, purpose?: string): Promise<ApprovalAnswer>;
  onFinish(result: { summary: string; commitMessage: string }): void;
}

const OUTPUT_FOR_EVENTS = 4000;

type Run<S extends z.ZodType> = (input: z.infer<S>, signal?: AbortSignal) => Promise<{ ok: boolean; output: string }>;

/**
 * The agent's tools, bound to one task's copy of the project. "read" mode, for the interview and
 * the spec, leaves out everything that changes files or runs commands. "review" mode, for the acceptance
 * agent, reads and runs commands but has no way to edit files or finish the task.
 */
/** Commands in a row that may run out of time before the answer stops running them. */
const HUNG_LIMIT = 3;

export function buildTools(ws: Workspace, hooks: ToolHooks, mode: "read" | "review" | "write" = "write", extra: ToolSet = {}): ToolSet {
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

  // Commands that ran out of time, one after another (seen live: a hidden Word hung every command for two hours and the
  // model kept killing it and trying again). After a few in a row this answer runs no more commands.
  let hungInARow = 0;
  const run_command = wrap(
    "run_command",
    "Run a shell command in the project folder, e.g. tests or a build. Returns the exit code and the end of the output.",
    z.object({
      command: z.string().min(1),
      purpose: z.string().max(300).optional().describe("What the command does and why, one short sentence in the user's language; the user sees it when the command asks for permission"),
      timeout_seconds: z.number().int().min(1).max(600).default(120),
    }),
    async ({ command, purpose, timeout_seconds }, signal) => {
      if (hungInARow >= HUNG_LIMIT) {
        return {
          ok: false,
          output:
            "Not run: commands hung three times in a row. Stop running commands now. Tell the user what you tried, that the commands kept hanging (a program may be waiting for input nobody can give, such as a hidden Office window), and suggest another way.",
        };
      }
      const verdict = classifyCommand(command, ws.root);
      if (verdict.action === "ask" && !(await hooks.askApproval(command, verdict.reason, signal, purpose))) {
        return { ok: false, output: "The user denied this command. Do not retry it; find another way or explain in finish." };
      }
      const result = await runCommand(command, ws.root, timeout_seconds * 1000, signal);
      hungInARow = result.timedOut ? hungInARow + 1 : 0;
      const head = result.timedOut ? `Timed out after ${timeout_seconds}s` : `Exit code: ${result.exitCode}`;
      return { ok: result.exitCode === 0 && !result.timedOut, output: `${head}\n${result.output}` };
    },
  );
  if (mode === "review") return { ...readTools, ...stepTools, run_command };

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
    run_command,
    update_notes: wrap(
      "update_notes",
      "Rewrite your section of the project's AGENTS.md: what any agent working here next must know (the goal, decisions, how to build, test and run, what is done and what is next, pitfalls). Short and current, not a diary; it starts every request.",
      z.object({ notes: z.string().min(1) }),
      async ({ notes }) => {
        writeNotes(ws.root, notes);
        return ok("Notes saved in AGENTS.md.");
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
