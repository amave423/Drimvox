import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeOfficeLeftovers } from "./office";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type CommandVerdict = { action: "allow" } | { action: "ask"; reason: "push" | "global" | "outside" | "system" | "download" | "browser" };

/** A browser of the user's: with a window it opens on the user's screen, with the user's profile. */
const BROWSER_NAME = String.raw`(?:chrome|msedge|firefox|brave|opera|vivaldi)(?:\.exe)?`;
const BROWSER = new RegExp(String.raw`(^|[\s;&|("'\\/])${BROWSER_NAME}(?=["'\s;)]|$)`, "i");
/** Run straight: as a command of its own, after `&`, or through Start-Process, by name or by its path. */
const RUNS_BROWSER = new RegExp(
  String.raw`(^|[;|]|&&?)\s*(?:(?:start-process|start|saps|invoke-item|ii)\s+(?:-filepath\s+)?)?["']?(?:[^"';|]*[\\/])?${BROWSER_NAME}["']?(?=[\s;|]|$)`,
  "i",
);
/** Run through a variable that holds its path: `$chrome = "…\chrome.exe"; & $chrome`. */
const RUNS_VARIABLE = /(^|[;|&])\s*(?:&|start-process\s+(?:-filepath\s+)?)\s*\$\w+/i;

/** Seen live: `chrome --version` opened the user's browser instead of printing a version. Looking for one is fine. */
function opensBrowser(command: string): boolean {
  if (/--headless\b/i.test(command)) return false;
  return RUNS_BROWSER.test(command) || (BROWSER.test(command) && RUNS_VARIABLE.test(command));
}

const rules: [RegExp, Exclude<CommandVerdict, { action: "allow" }>["reason"]][] = [
  [/\bgit\s+push\b/i, "push"],
  [/\b(npm|pnpm|bun)\b[^\n;&|]*\s(-g|--global)\b/i, "global"],
  [/\byarn\s+global\b/i, "global"],
  [/\bpip3?\s+install\b/i, "global"],
  [/\b(shutdown|restart-computer|stop-computer|format-volume|diskpart|bcdedit|set-executionpolicy)\b/i, "system"],
  [/\bformat\s+[a-z]:/i, "system"],
  [/\breg\s+(add|delete)\b/i, "system"],
  [/\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh|pwsh|powershell)\b/i, "download"],
  [/\b(iex|invoke-expression)\b[^\n]*\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring)\b/i, "download"],
];

/**
 * Decides whether the agent may run a command on its own or must ask first.
 * A guard against obvious harm, not a sandbox: the command still runs with the user's rights.
 */
export function classifyCommand(command: string, root: string): CommandVerdict {
  for (const [pattern, reason] of rules) if (pattern.test(command)) return { action: "ask", reason };
  if (opensBrowser(command)) return { action: "ask", reason: "browser" };
  if (/(^|[\s;&|(])(cd|chdir|set-location|pushd|sl)\s+["']?\.\.(?=[\\/\s"']|$)/i.test(command)) return { action: "ask", reason: "outside" };
  const home = realName(root);
  // Running an installed program (a browser for a headless look, say) touches nothing outside; moving or deleting it does.
  const movesFiles = MOVES_FILES.test(command);
  for (const path of absolutePaths(command)) {
    if (!movesFiles && PROGRAM.test(path)) continue;
    // Bare slashes in code (a string, a division, a // comment) are not the drive's root on Windows, unless something is deleted.
    if (process.platform === "win32" && /^\/+$/.test(path) && !movesFiles) continue;
    const rel = relative(home, realName(path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { action: "ask", reason: "outside" };
  }
  return { action: "allow" };
}

/**
 * The full name of a path, so that a short 8.3 name (C:\Users\12C2~1, given for Cyrillic user names) and the long one
 * compare equal. A path that does not exist yet keeps its missing tail on top of the real name of what exists.
 */
function realName(path: string): string {
  const full = resolve(path);
  for (let dir = full; ; dir = dirname(dir)) {
    if (existsSync(dir)) {
      try {
        return join(realpathSync.native(dir), relative(dir, full));
      } catch {
        return full;
      }
    }
    if (dirname(dir) === dir) return full;
  }
}

const PROGRAM = /\.(exe|com|cmd|bat)$/i;
const MOVES_FILES = /(^|[\s;&|(])(remove-item|rm|rmdir|rd|del|erase|move-item|mv|move|copy-item|cp|copy|rename-item|ren)(?=[\s;]|$)/i;

/** Windows drive paths, UNC paths, home paths and bare unix roots mentioned in a command. */
function absolutePaths(command: string): string[] {
  const found: string[] = [];
  // Quoted Windows paths may hold spaces ("C:\Program Files\..."); unquoted ones end at the first space.
  for (const m of command.matchAll(/"([a-zA-Z]:[\\/][^"]*)"|'([a-zA-Z]:[\\/][^']*)'|(?:^|[\s=(])([a-zA-Z]:[\\/][^\s"'`;|&)]*)/g)) {
    found.push((m[1] ?? m[2] ?? m[3])!);
  }
  for (const m of command.matchAll(/(?:^|[\s"'=(])((?:~|\/)[^\s"'`;|&)]*)/g)) {
    const path = m[1]!;
    // Command switches like /s or /T are not paths; a lone "/" or "/etc/..." is.
    if (/^\/[a-zA-Z?]{1,2}$/.test(path)) continue;
    // On Windows "/x" means the root of the drive, where code rarely points; '/api/boards' in a script is a URL path.
    // Only a folder that really sits at the root counts.
    // A regular expression such as /\\/g in code is not a folder either: only a plain name at the root counts.
    const top = path.split("/")[1];
    if (process.platform === "win32" && path.startsWith("/") && top && (!/^[\w .-]+$/.test(top) || !existsSync(resolve("/", top)))) continue;
    found.push(path.startsWith("~") ? path.replace(/^~/, process.env.USERPROFILE ?? process.env.HOME ?? "/") : path);
  }
  return found;
}

/**
 * Wraps a command so PowerShell prints UTF-8 and exits with the real exit code of the last program
 * (plain -Command turns every failure into 1). Encoding avoids quoting problems.
 */
function encodePowerShell(command: string): string {
  // With output redirected, PowerShell serialises progress bars and errors as CLIXML; the agent
  // needs them as plain text. Native programs set LASTEXITCODE; failed cmdlets only fill $Error.
  // The command is parsed here rather than as part of this script: a syntax error, such as `&&` that
  // Windows PowerShell 5.1 does not know, then becomes a readable message instead of CLIXML.
  const source = Buffer.from(command, "utf8").toString("base64");
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ProgressPreference = 'SilentlyContinue'",
    "$global:LASTEXITCODE = $null",
    "$Error.Clear()",
    `$source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${source}'))`,
    "try { $block = [ScriptBlock]::Create($source) } catch {",
    "  Write-Output $_.Exception.InnerException.Message",
    "  if ($source -match '&&|\\|\\|') { Write-Output 'Windows PowerShell 5.1 has no && or ||: separate commands with ; or use if ($?) { ... }.' }",
    "  exit 1",
    "}",
    "& $block 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { $_ } } | Out-String -Stream -Width 4096",
    "if ($global:LASTEXITCODE -ne $null) { exit $global:LASTEXITCODE } elseif ($Error.Count -gt 0) { exit 1 }",
  ].join("\n");
  return Buffer.from(script, "utf16le").toString("base64");
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

const OUTPUT_LIMIT = 12_000;

/** Starts a command in the user's shell: PowerShell on Windows, sh elsewhere (in its own process group). */
export function spawnShell(command: string, cwd: string): ChildProcessWithoutNullStreams {
  return process.platform === "win32"
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], { cwd, windowsHide: true })
    : spawn("/bin/sh", ["-c", command], { cwd, detached: true });
}

/** Stops a command and everything it started, such as a dev server's workers. */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** How long the output may stay open after the shell has exited. */
const LINGER_MS = 2_000;

/** Runs a shell command in `cwd`; keeps the tail of the output and kills the whole tree on timeout. */
export function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((done) => {
    // A second back: the clock of a process's start is coarser than this one.
    const startedAt = new Date(Date.now() - 1000);
    const child = spawnShell(command, cwd);

    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      child.stdout.destroy();
      child.stderr.destroy();
      const tail = output.length > OUTPUT_LIMIT ? `…\n${output.slice(-OUTPUT_LIMIT)}` : output;
      done({ exitCode, output: tail.trimEnd(), timedOut });
    };
    // A program the command started can outlive it and hold its output open (seen live: `chrome --version` on Windows
    // opened the browser and the command never ended, not even at its timeout). Once the shell is gone, or killed,
    // the output is taken as complete a moment later.
    const soon = (exitCode: number | null) => setTimeout(() => finish(exitCode), LINGER_MS).unref();
    const kill = () => {
      killTree(child);
      // A hidden Office it started through COM is not in its tree (seen live: Word stayed, waiting for an answer).
      void closeOfficeLeftovers(startedAt);
      soon(null);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });

    child.on("exit", (code) => soon(code));
    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      output += String(err);
      finish(null);
    });
  });
}
