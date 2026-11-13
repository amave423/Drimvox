import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeOfficeLeftovers } from "./office";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type CommandVerdict =
  | { action: "allow" }
  | { action: "ask"; reason: "push" | "global" | "outside" | "system" | "download" | "browser" | "ssh" }
  | { action: "deny"; reason: "destroy" };

/**
 * Never run, even when asked: deleting a repository or rewriting what was pushed (asked for: the agent commits itself,
 * as in OpenCode, and may never delete a repository).
 */
const DESTROYS = [
  /\bgh\s+repo\s+delete\b/i,
  /\bgh\s+api\b[^\n;|]*(-X|--method)\s*DELETE\b[^\n;|]*\brepos\//i,
  /\bgit\s+push\b[^\n;|&]*(\s--force(-with-lease)?\b|\s-f\b)/i,
  /\b(rm|del|rmdir|rd|remove-item|ri)\b[^\n;|&]*(^|[\s"'\/])\.git(["'\s\/]|$)/i,
];

/** Where tools keep what they download for builds and tests: using them touches nothing of the user's. */
const TOOL_CACHES = ["electron-builder", "electron", "ms-playwright", "npm-cache", "node-gyp", "pnpm", "Yarn", "pip", "Cypress"];

function inToolCache(path: string): boolean {
  const roots = [process.env.LOCALAPPDATA, process.env.APPDATA, process.env.HOME && join(process.env.HOME, ".cache")].filter((r): r is string => !!r);
  return roots.some((root) =>
    TOOL_CACHES.some((name) => {
      const rel = relative(join(root, name), path);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    }),
  );
}

/**
 * Inside the system's temporary folder (not the folder itself): probes and scripts of the tester's and the agent's own,
 * nobody's files (seen live: the tester asked for permission to write its probe there, as its rules tell it to).
 */
function inTemp(path: string, home: string): boolean {
  const temp = realName(tmpdir());
  const inside = (p: string) => {
    const rel = relative(temp, p);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  // A project kept in the temporary folder itself has its neighbours there: those are someone's.
  return inside(realName(path)) && !inside(home);
}

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

const rules: [RegExp, Extract<CommandVerdict, { action: "ask" }>["reason"]][] = [
  [/\bgit\s+push\b/i, "push"],
  // Seen: plink downloaded and run with the server's password in the command, kept in the chat (ssh_run does it safely).
  [/\b(plink|putty|sshpass)(\.exe)?\b/i, "ssh"],
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
/**
 * A relative `cd` that ends outside the folder, the `cd`s followed in order (seen live: `cd server && npm test && cd ../app`
 * asked for permission, though ../app is the project's own).
 */
function leavesFolder(command: string, root: string): boolean {
  const top = resolve(root);
  let at = top;
  for (const m of command.matchAll(/(?:^|[\s;&|(])(?:cd|chdir|set-location|pushd|sl)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/gi)) {
    const to = (m[1] ?? m[2] ?? m[3])!;
    // Absolute paths are judged with the other paths of the command, below.
    if (isAbsolute(to) || /^[a-zA-Z]:/.test(to) || to.startsWith("/") || to.startsWith("~")) continue;
    at = resolve(at, to);
    const rel = relative(top, at);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;
  }
  return false;
}

export function classifyCommand(command: string, root: string): CommandVerdict {
  if (DESTROYS.some((p) => p.test(command))) return { action: "deny", reason: "destroy" };
  for (const [pattern, reason] of rules) if (pattern.test(command)) return { action: "ask", reason };
  if (opensBrowser(command)) return { action: "ask", reason: "browser" };
  if (leavesFolder(command, root)) return { action: "ask", reason: "outside" };
  const home = realName(root);
  // Running an installed program (a browser for a headless look, say) touches nothing outside; moving or deleting it does.
  const movesFiles = MOVES_FILES.test(command);
  for (const path of absolutePaths(command)) {
    if (!movesFiles && PROGRAM.test(path)) continue;
    if (inToolCache(path) || inTemp(path, home)) continue;
    // Bare slashes in code (a string, a division, a // comment, a regular expression in `node -e`) are not the drive's root
    // on Windows, unless the root itself is what is moved or deleted (seen live: `cp a /tmp/b && node -e "s.replace(/x/, …)"`
    // asked for permission).
    if (process.platform === "win32" && /^\/+$/.test(path) && !MOVES_ROOT.test(command)) continue;
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
/** The root itself given to a command that moves or deletes: `rm -rf /`, `del /`. */
const MOVES_ROOT = /(^|[\s;&|(])(remove-item|rm|rmdir|rd|del|erase|move-item|mv|move|copy-item|cp|copy)(\s+-{1,2}[\w-]+)*\s+["']?\/+["']?(?=[\s;&|)]|$)/i;
const MOVES_FILES =/(^|[\s;&|(])(remove-item|rm|rmdir|rd|del|erase|move-item|mv|move|copy-item|cp|copy|rename-item|ren)(?=[\s;]|$)/i;

/** Windows drive paths, UNC paths, home paths and bare unix roots mentioned in a command. */
function absolutePaths(command: string): string[] {
  const found: string[] = [];
  // Quoted Windows paths may hold spaces ("C:\Program Files\..."); unquoted ones end at the first space.
  for (const m of command.matchAll(/"([a-zA-Z]:[\\/][^"]*)"|'([a-zA-Z]:[\\/][^']*)'|(?:^|[\s=(])([a-zA-Z]:[\\/][^\s"'`;|&)]*)/g)) {
    found.push((m[1] ?? m[2] ?? m[3])!);
  }
  for (const m of command.matchAll(/(?:^|[\s"'=(])((?:~|\/)[^\s"'`;|&)]*)/g)) {
    const path = m[1]!;
    // Command switches like /s or /T are not paths, nor //F as Git Bash writes them (seen: `taskkill //F //IM app.exe`
    // asked for permission); a lone "/" or "/etc/..." is. /dev/null is nobody's file.
    if (/^\/{1,2}[a-zA-Z?]{1,2}$/.test(path) || path === "/dev/null") continue;
    // On Windows "/x" means the root of the drive, where code rarely points; '/api/boards' in a script is a URL path.
    // Only a folder that really sits at the root counts.
    // A regular expression such as /\\/g in code is not a folder either: only a plain name at the root counts.
    const top = path.split("/")[1];
    // Git Bash names a drive /c/…: the same folder as C:\….
    const drive = process.platform === "win32" ? /^\/([a-zA-Z])(?=\/|$)/.exec(path) : null;
    if (drive) {
      found.push(`${drive[1]!.toUpperCase()}:/${path.slice(3)}`);
      continue;
    }
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
  /** The whole output, when `output` shows only part of it (up to FULL_LIMIT). */
  full?: string;
}

const OUTPUT_LIMIT = 12_000;
/** Of a long output, the start shown before its end: the command's first errors are often there. */
const HEAD_LIMIT = 2_000;
/** The whole output kept for a file, at most this much. */
const FULL_LIMIT = 5_000_000;

/**
 * No sign-in windows from the agent's commands: Git Credential Manager asked the user for GitHub's eight-letter code again
 * and again when an agent's git command reached GitHub (seen). Such a command fails instead, with git's own words.
 */
export const NO_PROMPTS = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" };

let bashFound: string | null | undefined;

/**
 * Git for Windows' bash, when Git is installed: the agent's commands run in it on Windows, as in Claude Code. Models write
 * bash whatever they are told (seen live: `npm install | tail -5` in PowerShell hid npm's output, and the agent dropped the
 * SQLite it was asked for, thinking it would not install, though it did). DRIMVOX_SHELL=powershell keeps PowerShell.
 */
export function gitBash(): string | null {
  if (process.platform !== "win32" || process.env.DRIMVOX_SHELL === "powershell") return null;
  if (bashFound !== undefined) return bashFound;
  const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")];
  const candidates = roots.filter((r): r is string => !!r).map((r) => join(r, "Git", "bin", "bash.exe"));
  // Git elsewhere: its bash sits two folders up from git.exe (…\Git\cmd\git.exe → …\Git\bin\bash.exe).
  for (const dir of (process.env.PATH ?? "").split(";")) if (/[\\/]git[\\/](cmd|bin|mingw64[\\/]bin)[\\/]?$/i.test(dir)) candidates.push(join(dir, /mingw64/i.test(dir) ? "../.." : "..", "bin", "bash.exe"));
  bashFound = candidates.map((c) => resolve(c)).find((c) => existsSync(c)) ?? null;
  return bashFound;
}

/** The shell the agent's commands run in, as its instructions say it. */
export function shellNote(platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return "sh";
  if (platform === process.platform && gitBash())
    return "bash (Git for Windows): Unix commands, pipes and && work; write paths as C:/Users/... For Windows-only things run powershell -NoProfile -Command \"...\"";
  return "Windows PowerShell 5.1 (no && or ||: separate commands with ; or use if ($?) { ... })";
}

/** Starts a command in the user's shell: bash or PowerShell on Windows, sh elsewhere (in its own process group). */
export function spawnShell(command: string, cwd: string, env?: Record<string, string>): ChildProcessWithoutNullStreams {
  const withEnv = { env: { ...process.env, ...NO_PROMPTS, ...env } };
  const bash = process.platform === "win32" ? gitBash() : null;
  const child =
    process.platform !== "win32"
      ? spawn("/bin/sh", ["-c", command], { cwd, detached: true, ...withEnv })
      : bash
        ? spawn(bash, ["-c", command], { cwd, windowsHide: true, ...withEnv })
        : spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)], { cwd, windowsHide: true, ...withEnv });
  // Nobody types into it: a program that asks (npx's "Ok to proceed?", a prompt for a password) reads the end at once
  // instead of waiting to its timeout (seen live: the agent noted "run_command often hangs" and turned to start_background).
  child.stdin.end();
  return child;
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
export function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal, env?: Record<string, string>): Promise<CommandResult> {
  return new Promise((done) => {
    // A second back: the clock of a process's start is coarser than this one.
    const startedAt = new Date(Date.now() - 1000);
    const child = spawnShell(command, cwd, env);

    let output = "";
    let full = "";
    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      if (full.length < FULL_LIMIT) full += text;
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
      if (full.length <= OUTPUT_LIMIT) return done({ exitCode, output: output.trimEnd(), timedOut });
      // Long: its start and its end, and the whole of it for a file (tools.ts).
      const end = OUTPUT_LIMIT - HEAD_LIMIT;
      const skipped = full.length - HEAD_LIMIT - end;
      const shown = skipped > 0 ? `${full.slice(0, HEAD_LIMIT)}\n… ${skipped} characters skipped …\n${output.slice(-end)}` : full;
      done({ exitCode, output: shown.trimEnd(), timedOut, full });
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
