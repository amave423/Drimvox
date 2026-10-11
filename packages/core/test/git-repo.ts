import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Commits in tests need an identity even on machines without a global git config. */
process.env.GIT_AUTHOR_NAME ??= "Test User";
process.env.GIT_AUTHOR_EMAIL ??= "test@example.com";
process.env.GIT_COMMITTER_NAME ??= "Test User";
process.env.GIT_COMMITTER_EMAIL ??= "test@example.com";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A fresh repository with the given files committed on `main`. */
export function makeRepo(files: Record<string, string> = { "README.md": "# Demo\n" }): string {
  const dir = mkdtempSync(join(tmpdir(), "artel-repo-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFiles(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Initial commit");
  return dir;
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
