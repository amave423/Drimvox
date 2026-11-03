import type { ProjectPlan } from "@drimvox/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCommand, runCommand } from "../agent/commands";

/** How long one check may run. */
const CHECK_MS = 300_000;
/** Lines of a check's output kept: the end, where a test runner says what failed. */
const TAIL_LINES = 30;
/** npm's own placeholder when a project has no tests. */
const NO_TESTS = /no test specified/i;

/**
 * The project's own checks Drimvox runs itself before the work is done (said in a video on agents: take the raw output
 * of the tests, not the model's word that all is fixed): the plan's checks that are package scripts the project has, else
 * its `npm test`. Only scripts that are there: a plan's check in words, or a command the project lacks, is not run.
 */
export function projectChecks(folder: string, plan: ProjectPlan | null): string[] {
  const file = join(folder, "package.json");
  if (!existsSync(file)) return [];
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return [];
  }
  const has = (name: string) => typeof scripts[name] === "string" && !(name === "test" && NO_TESTS.test(scripts[name]!));
  const named = (plan?.checks ?? [])
    .map((c) => c.trim())
    .filter((c) => {
      const m = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)$/.exec(c);
      return !!m && has(m[1]!);
    });
  const commands = named.length ? named : has("test") ? ["npm test"] : [];
  // Nothing that would need the user's permission.
  return [...new Set(commands)].filter((c) => classifyCommand(c, folder).action !== "ask");
}

export interface CheckResult {
  command: string;
  ok: boolean;
  /** The end of its raw output. */
  tail: string;
}

/** Runs the checks one after another, as in CI (no watch mode). */
export async function runChecks(folder: string, commands: string[], signal?: AbortSignal): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    const r = await runCommand(command, folder, CHECK_MS, signal, { CI: "true" });
    const tail = r.output.split(/\r?\n/).slice(-TAIL_LINES).join("\n").trim();
    results.push({ command, ok: r.exitCode === 0 && !r.timedOut, tail: r.timedOut ? `${tail}\n(stopped after ${CHECK_MS / 1000} s)` : tail });
  }
  return results;
}

/** What the agent is told when a check failed: the raw output, to fix the cause. */
export function checksFailedMessage(results: CheckResult[]): string {
  const failed = results.filter((r) => !r.ok);
  return [
    "Before the work is done, Drimvox ran the project's checks itself, and these failed. Here is their raw output.",
    ...failed.map((r) => `\n$ ${r.command}\n${r.tail || "(no output)"}`),
    "\nFix the cause (not the test), run the check yourself to see it pass, then call finish_work again.",
  ].join("\n");
}

/** The checks as the report shows them to the user, in Russian or English, with the raw end of each output. */
export function checksReport(results: CheckResult[], ru: boolean): string {
  const lines = results.map((r) => {
    const verdict = r.ok ? (ru ? "прошли" : "passed") : ru ? "не прошли" : "failed";
    return `- \`${r.command}\` — ${verdict}\n\n\`\`\`\n${r.tail || (ru ? "(без вывода)" : "(no output)")}\n\`\`\``;
  });
  return [ru ? "**Проверки, которые Drimvox запустил сам**" : "**Checks Drimvox ran itself**", ...lines].join("\n\n");
}
