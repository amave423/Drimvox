import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A git failure the API can explain: git missing, no author identity, or a refusal. */
export class GitError extends Error {
  constructor(
    readonly code: "no_git" | "no_identity" | "failed",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Another git touching the same repository holds a lock for a moment: an agent of the team merging, a worktree being
 * added, git rewriting its config (on Windows a file being replaced cannot be read). Such a command is tried again.
 */
const BUSY = /index\.lock': File exists|could not lock config file|unable to access '[^']*config': Permission denied|Unable to create '[^']*\.lock'/i;
const RETRY_MS = [150, 400, 900, 1800];

/** Runs git and resolves even on a non-zero exit; only a missing git binary rejects. */
export async function runGit(cwd: string, args: string[], allowFail = false, env?: Record<string, string>): Promise<GitResult> {
  for (let attempt = 0; ; attempt++) {
    const result = await runOnce(cwd, args, env);
    if (result.code !== 0 && BUSY.test(result.stderr) && attempt < RETRY_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_MS[attempt]));
      continue;
    }
    if (result.code !== 0 && !allowFail) throw new GitError("failed", `git ${args[0]}: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  }
}

function runOnce(cwd: string, args: string[], env?: Record<string, string>): Promise<GitResult> {
  // Deep folders (a dependency's cache, say) pass Windows' 260-character limit; git handles them only when told to.
  const full = process.platform === "win32" ? ["-c", "core.longpaths=true", ...args] : args;
  return new Promise((resolve, reject) => {
    execFile("git", full, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: env ? { ...process.env, ...env } : undefined }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      if (err && (err as { code?: unknown }).code === "ENOENT") {
        reject(new GitError("no_git", "Git is not installed"));
        return;
      }
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

const out = async (cwd: string, args: string[]) => (await runGit(cwd, args)).stdout.trim();

/** Commits that only exist inside Drimvox's copies carry Drimvox's name; accepted work carries the user's. */
const drimvoxIdentity = ["-c", "user.name=Drimvox", "-c", "user.email=drimvox@localhost"];

/**
 * True when `dir` is the top of a git repository. A folder nested inside another repository is not:
 * the agent would otherwise copy and change the whole outer project.
 */
export async function isRepoRoot(dir: string): Promise<boolean> {
  // Compares no paths: Windows may spell the same folder in short (8.3) and long form.
  const res = await runGit(dir, ["rev-parse", "--is-inside-work-tree", "--show-prefix"], true);
  if (res.code !== 0) return false;
  const [inside, prefix = ""] = res.stdout.split("\n");
  return inside?.trim() === "true" && prefix.trim() === "";
}

/**
 * Starts git in a plain folder with one commit of what is there, dependency folders left out. Without a name and email
 * in git, this repository alone gets the computer's user name: the user need not know about git to start.
 */
export async function initWithCommit(dir: string): Promise<void> {
  // "main", whatever git's own default (seen: a project got a "master" beside the agent's branch).
  await runGit(dir, ["init", "-q", "-b", "main"]);
  if ((await runGit(dir, ["var", "GIT_AUTHOR_IDENT"], true)).code !== 0) {
    const name = userInfo().username || "Drimvox user";
    await runGit(dir, ["config", "user.name", name]);
    await runGit(dir, ["config", "user.email", `${name.replace(/[^\w.-]/g, "") || "user"}@localhost`]);
  }
  await runGit(dir, ["add", "-A", "--", ".", ...withoutDependencies()]);
  await runGit(dir, ["commit", "-q", "--allow-empty", "-m", "Initial commit"]);
}

export async function headCommit(repo: string): Promise<string> {
  return out(repo, ["rev-parse", "HEAD"]);
}

export async function currentBranch(repo: string): Promise<string | null> {
  const res = await runGit(repo, ["symbolic-ref", "--short", "-q", "HEAD"], true);
  return res.code === 0 ? res.stdout.trim() : null;
}

/** Records everything in the copy as a commit on the task branch. Returns false when nothing changed. */
/**
 * Installed dependencies and tool caches: never part of an agent's work, even in a project without a .gitignore.
 * A project that keeps one of them in git keeps getting its changes.
 */
export const NEVER_ADDED = ["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".next", ".nuxt", ".turbo", ".parcel-cache"];
export const anywhere = (name: string) => `:(glob)**/${name}/**`;
/** Pathspecs that leave dependency folders out of `git add`, wherever they are. */
export const withoutDependencies = () => NEVER_ADDED.map((name) => `:(exclude,glob)**/${name}/**`);

/**
 * What an app's build leaves: installers and unpacked apps (seen live: an Electron app's Fiit.exe of 180 MB went into the
 * commit, and GitHub refused every push after it). They are published as release files, never committed.
 */
const BUILT = ["**/win-unpacked/**", "**/linux-unpacked/**", "**/mac-unpacked/**", "**/*.exe", "**/*.msi", "**/*.dmg", "**/*.AppImage", "**/*.blockmap", "**/*.nupkg"];
/** A file this big is left out: GitHub warns at 50 MB and refuses the push of a file over 100 MB. */
export const BIG_FILE = 50 * 1024 * 1024;

/**
 * Stages the work: everything but dependency folders the project does not track, built apps and files too big for
 * GitHub, and what `exclude` adds (secrets). Returns false when git refused.
 */
export async function addWork(folder: string, exclude: string[] = []): Promise<boolean> {
  const tracked = lines(await out(folder, ["ls-files", "--", ...NEVER_ADDED.map(anywhere)])).map((p) => p.split("/"));
  const skipped = NEVER_ADDED.filter((name) => !tracked.some((parts) => parts.includes(name)));
  const specs = [...skipped.map((name) => `**/${name}/**`), ...BUILT, ...exclude].map((glob) => `:(exclude,glob)${glob}`);
  if ((await runGit(folder, ["add", "-A", "--", ".", ...specs], true)).code !== 0) return false;
  const added = (await runGit(folder, ["diff", "--cached", "--name-only", "-z", "--diff-filter=AM"], true)).stdout.split("\0").filter(Boolean);
  const big = added.filter((path) => {
    try {
      return statSync(join(folder, path)).size > BIG_FILE;
    } catch {
      return false;
    }
  });
  if (big.length) await runGit(folder, ["reset", "-q", "--", ...big], true);
  return true;
}

export async function commitAll(worktree: string, message: string): Promise<boolean> {
  await addWork(worktree);
  const staged = await runGit(worktree, ["diff", "--cached", "--quiet"], true);
  if (staged.code === 0) return false;
  await runGit(worktree, [...drimvoxIdentity, "commit", "-q", "--no-verify", "-m", message]);
  return true;
}

function lines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

