import type { ProviderError } from "@artel/shared";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { killTree } from "../agent/commands";
import { CLI_KINDS, longPath, type CliEvent, type CliId, type CliLaunch } from "./kinds";
import { resolveCli } from "./resolve";

export interface CliRunInput extends CliLaunch {
  id: CliId;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  /** Give up when the CLI prints nothing for this long. */
  idleTimeoutMs: number;
  onEvent(event: CliEvent): void;
}

export type CliDone = Extract<CliEvent, { kind: "done" }>;

export interface CliRunResult {
  session: string | null;
  done: CliDone | null;
  stopped: boolean;
  /** Set when the run did not end with an answer. */
  error: ProviderError | null;
}

/** One turn of a CLI: start it, give it the prompt, read its stream to the end. */
export function runCli(i: CliRunInput): Promise<CliRunResult> {
  const argv = resolveCli(i.id);
  if (!argv) return Promise.resolve({ session: null, done: null, stopped: false, error: { code: "cli_missing" } });
  const kind = CLI_KINDS[i.id];
  // The full name, the one the CLI reports paths under.
  const cwd = longPath(i.cwd);
  const parse = kind.parser(cwd);

  return new Promise((resolve) => {
    let session: string | null = null;
    let done: CliDone | null = null;
    let stderr = "";
    let silent = false;
    let spawnError: NodeJS.ErrnoException | null = null;

    const child = spawn(argv[0]!, [...argv.slice(1), ...kind.args(i)], {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resetClock = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        silent = true;
        killTree(child);
      }, i.idleTimeoutMs);
    };
    const stop = () => killTree(child);
    i.signal.addEventListener("abort", stop, { once: true });
    resetClock();

    child.on("error", (err) => (spawnError = err));
    child.stdin.on("error", () => {});
    child.stdin.end(i.prompt);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      resetClock();
      stderr = (stderr + chunk).slice(-4000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      resetClock();
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      for (const event of parse(parsed as Record<string, unknown>)) {
        if (event.kind === "session") session = event.id;
        if (event.kind === "done") done = event;
        i.onEvent(event);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      i.signal.removeEventListener("abort", stop);
      const stopped = i.signal.aborted;
      const finished = done as CliDone | null;
      let error: ProviderError | null = null;
      if (stopped) error = null;
      else if (spawnError) error = spawnError.code === "ENOENT" ? { code: "cli_missing" } : { code: "provider_error", detail: spawnError.message };
      else if (silent) error = { code: "timeout" };
      else if (finished?.error) error = classify(finished.error);
      else if (!finished) error = classify(stderr.trim() || `The program ended with code ${code ?? "?"} and no answer`);
      resolve({ session, done: finished, stopped, error });
    });
  });
}

/** A CLI that is not logged in says so in its own words; everything else is the provider's error. */
export function classify(message: string): ProviderError {
  const detail = message.length > 300 ? `${message.slice(0, 300)}…` : message;
  if (/not logged in|\/login|please log ?in|run .*login|authenticat|unauthori[sz]ed|invalid api key|credentials/i.test(message)) {
    return { code: "cli_login", detail };
  }
  if (/rate.?limit|usage limit|quota/i.test(message)) return { code: "rate_limited", detail };
  return { code: "provider_error", detail };
}
