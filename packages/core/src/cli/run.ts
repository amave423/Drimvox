import { rememberLimit } from "./limits";
import { REGION } from "../providers/errors";
import type { ProviderError } from "@artel/shared";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { killTree } from "../agent/commands";
import { CLI_KINDS, longPath, type CliEvent, type CliId, type CliLaunch } from "./kinds";
import { rememberDefault } from "./models";
import { resolveCli } from "./resolve";

export interface CliRunInput extends CliLaunch {
  id: CliId;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  /** Give up when the CLI prints nothing for this long. */
  idleTimeoutMs: number;
  /** The provider wants its traffic through the proxy; `proxy` is the address, null when none is set. */
  useProxy: boolean;
  proxy: string | null;
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
  if (i.useProxy && !i.proxy) return Promise.resolve({ session: null, done: null, stopped: false, error: { code: "no_proxy" } });
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
      // The CLIs read the usual proxy variables; Node-based ones also need to be told to honour them.
      env: i.proxy
        ? { ...process.env, HTTPS_PROXY: i.proxy, HTTP_PROXY: i.proxy, https_proxy: i.proxy, http_proxy: i.proxy, NODE_USE_ENV_PROXY: "1" }
        : process.env,
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
    child.stdin.end(kind.input ? kind.input(i.prompt) : i.prompt);
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
        if (event.kind === "limit") rememberLimit(i.id, event.limit);
        if (event.kind === "session" && event.model && i.model === "default") rememberDefault(i.id, event.model);
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
  // Google stopped serving Gemini CLI to personal accounts on June 18, 2026; signing in again does not help.
  if (/no longer supported for Gemini Code Assist|migrate to Antigravity/i.test(message)) return { code: "cli_retired", detail };
  // The vendor does not serve the account where it is (seen: Antigravity from Russia); a VPN or a proxy helps, signing in does not.
  if (REGION.test(message)) return { code: "region", detail };
  if (/not logged in|\/login|please log ?in|run .*login|authenticat|unauthori[sz]ed|invalid api key|credentials/i.test(message)) {
    return { code: "cli_login", detail };
  }
  if (/does not support this model|newer is required|claude update|please update|upgrade to the latest/i.test(message)) return { code: "cli_update", detail };
  if (/out of usage|usage credits|usage limit|limit reached|reached your .*limit|quota/i.test(message)) return { code: "cli_limit", detail };
  if (/rate.?limit/i.test(message)) return { code: "rate_limited", detail };
  return { code: "provider_error", detail };
}
