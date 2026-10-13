import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type CommandVerdict = { action: "allow" } | { action: "ask"; reason: "push" | "global" | "outside" | "system" | "download" };

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
  if (/(^|[\s;&|(])(cd|chdir|set-location|pushd|sl)\s+["']?\.\.(?=[\\/\s"']|$)/i.test(command)) return { action: "ask", reason: "outside" };
  const home = realName(root);
  for (const path of absolutePaths(command)) {
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

/** Windows drive paths, UNC paths, home paths and bare unix roots mentioned in a command. */
function absolutePaths(command: string): string[] {
  const found: string[] = [];
  for (const m of command.matchAll(/(?:^|[\s"'=(])([a-zA-Z]:[\\/][^\s"'`;|&)]*)/g)) found.push(m[1]!);
  for (const m of command.matchAll(/(?:^|[\s"'=(])((?:~|\/)[^\s"'`;|&)]*)/g)) {
    const path = m[1]!;
    // Command switches like /s or /T are not paths; a lone "/" or "/etc/..." is.
    if (/^\/[a-zA-Z?]{1,2}$/.test(path)) continue;
    // On Windows "/x" means the root of the drive, where code rarely points; '/api/boards' in a script is a URL path.
    // Only a folder that really sits at the root counts.
    const top = path.split("/")[1];
    if (process.platform === "win32" && path.startsWith("/") && top && !existsSync(resolve("/", top))) continue;
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

/** Runs a shell command in `cwd`; keeps the tail of the output and kills the whole tree on timeout. */
export function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((done) => {
    const child = spawnShell(command, cwd);

    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let timedOut = false;
    const kill = () => killTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      const tail = output.length > OUTPUT_LIMIT ? `…\n${output.slice(-OUTPUT_LIMIT)}` : output;
      done({ exitCode, output: tail.trimEnd(), timedOut });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      output += String(err);
      finish(null);
    });
  });
}
