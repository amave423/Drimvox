import { execFile } from "node:child_process";

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

/** Runs git and resolves even on a non-zero exit; only a missing git binary rejects. */
export function runGit(cwd: string, args: string[], allowFail = false): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      if (err && (err as { code?: unknown }).code === "ENOENT") {
        reject(new GitError("no_git", "Git is not installed"));
        return;
      }
      const result = { code, stdout: stdout.toString(), stderr: stderr.toString() };
      if (code !== 0 && !allowFail) reject(new GitError("failed", `git ${args[0]}: ${result.stderr.trim() || result.stdout.trim()}`));
      else resolve(result);
    });
  });
}

const out = async (cwd: string, args: string[]) => (await runGit(cwd, args)).stdout.trim();

/** Commits that only exist inside Artel's copies carry Artel's name; accepted work carries the user's. */
const artelIdentity = ["-c", "user.name=Artel", "-c", "user.email=artel@localhost"];

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

export async function ensureIdentity(dir: string): Promise<void> {
  const res = await runGit(dir, ["var", "GIT_AUTHOR_IDENT"], true);
  if (res.code !== 0) throw new GitError("no_identity", "git user.name and user.email are not set");
}

export async function initWithCommit(dir: string): Promise<void> {
  await ensureIdentity(dir);
  await runGit(dir, ["init", "-q"]);
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-q", "--allow-empty", "-m", "Initial commit"]);
}

export async function headCommit(repo: string): Promise<string> {
  return out(repo, ["rev-parse", "HEAD"]);
}

export async function currentBranch(repo: string): Promise<string | null> {
  const res = await runGit(repo, ["symbolic-ref", "--short", "-q", "HEAD"], true);
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  await runGit(repo, ["worktree", "add", "-q", "-b", branch, path, base]);
}

export async function removeWorktree(repo: string, path: string, branch: string): Promise<void> {
  await runGit(repo, ["worktree", "remove", "--force", path], true);
  await runGit(repo, ["worktree", "prune"], true);
  await runGit(repo, ["branch", "-D", branch], true);
}

/** Records everything in the copy as a commit on the task branch. Returns false when nothing changed. */
export async function commitAll(worktree: string, message: string): Promise<boolean> {
  await runGit(worktree, ["add", "-A"]);
  const staged = await runGit(worktree, ["diff", "--cached", "--quiet"], true);
  if (staged.code === 0) return false;
  await runGit(worktree, [...artelIdentity, "commit", "-q", "--no-verify", "-m", message]);
  return true;
}

export async function diffText(repo: string, base: string, head: string): Promise<string> {
  return (await runGit(repo, ["diff", "--no-color", "--no-ext-diff", "--find-renames", base, head])).stdout;
}

export async function changedFiles(repo: string, base: string, head: string): Promise<string[]> {
  return lines(await out(repo, ["diff", "--name-only", "--find-renames", base, head]));
}

/** Files with uncommitted or staged edits in the user's working folder. */
export async function dirtyFiles(repo: string): Promise<string[]> {
  // Not trimmed: each entry starts with a two-letter status that may begin with a space.
  const status = (await runGit(repo, ["status", "--porcelain", "-z", "--untracked-files=all"])).stdout;
  return status
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
}

/** Files that would conflict if `branch` were merged into HEAD, without touching the working folder. */
export async function conflictingFiles(repo: string, branch: string): Promise<string[]> {
  const res = await runGit(repo, ["merge-tree", "--write-tree", "--name-only", "HEAD", branch], true);
  if (res.code === 0) return [];
  if (res.code !== 1) throw new GitError("failed", `git merge-tree: ${res.stderr.trim()}`);
  const [, ...rest] = res.stdout.split("\n");
  const files: string[] = [];
  for (const line of rest) {
    if (!line.trim()) break;
    files.push(line.trim());
  }
  return [...new Set(files)];
}

/** Brings the branch onto the current branch as one commit authored by the user. */
export async function squashInto(repo: string, branch: string, message: string): Promise<string | null> {
  await runGit(repo, ["merge", "--squash", "-q", branch]);
  const staged = await runGit(repo, ["diff", "--cached", "--quiet"], true);
  if (staged.code === 0) return null;
  await runGit(repo, ["commit", "-q", "-m", message]);
  return headCommit(repo);
}

function lines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

