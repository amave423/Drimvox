import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
  for (const path of absolutePaths(command)) {
    const rel = relative(root, resolve(path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { action: "ask", reason: "outside" };
  }
  return { action: "allow" };
}

/** Windows drive paths, UNC paths, home paths and bare unix roots mentioned in a command. */
function absolutePaths(command: string): string[] {
  const found: string[] = [];
  for (const m of command.matchAll(/(?:^|[\s"'=(])([a-zA-Z]:[\\/][^\s"'`;|&)]*)/g)) found.push(m[1]!);
  for (const m of command.matchAll(/(?:^|[\s"'=(])((?:~|\/)[^\s"'`;|&)]*)/g)) {
    const path = m[1]!;
    // Command switches like /s or /T are not paths; a lone "/" or "/etc/..." is.
    if (/^\/[a-zA-Z?]{1,2}$/.test(path)) continue;
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
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ProgressPreference = 'SilentlyContinue'",
    "$global:LASTEXITCODE = $null",
    "$Error.Clear()",
    `& {\n${command}\n} 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { $_ } } | Out-String -Stream -Width 4096`,
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

/** Runs a shell command in `cwd`; keeps the tail of the output and kills the whole tree on timeout. */
export function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((done) => {
    const windows = process.platform === "win32";
    const child = windows
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], {
          cwd,
          windowsHide: true,
        })
      : spawn("/bin/sh", ["-c", command], { cwd, detached: true });

    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let timedOut = false;
    const kill = () => {
      if (child.exitCode !== null || !child.pid) return;
      if (windows) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
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
