import { classifyCommand, runCommand } from "./commands";

export interface CheckResult {
  command: string;
  exitCode: number | null;
  ok: boolean;
  output: string;
}

const CHECK_TIMEOUT_MS = 10 * 60_000;

/** Runs the task's checks in its copy, one after another. Drimvox's own verdict, not the agent's. */
export async function runChecks(commands: string[], cwd: string, signal?: AbortSignal): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    if (signal?.aborted) break;
    const r = await runCommand(command, cwd, CHECK_TIMEOUT_MS, signal);
    results.push({ command, exitCode: r.exitCode, ok: r.exitCode === 0 && !r.timedOut, output: r.output });
  }
  return results;
}

/** Checks from a spec nobody looked at may not do anything the agent would have to ask about. */
export function safeChecks(commands: string[], root: string): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const c of commands) (classifyCommand(c, root).action === "allow" ? kept : dropped).push(c);
  return { kept, dropped };
}

/** Failing checks as a message for the agent: command, exit code and the end of the output. */
export function failureReport(results: CheckResult[]): string {
  return results
    .filter((r) => !r.ok)
    .map((r) => `$ ${r.command}\nExit code: ${r.exitCode ?? "timeout"}\n${r.output.slice(-3000)}`)
    .join("\n\n");
}
