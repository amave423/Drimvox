import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Git without installing it: Drimvox works through git (the task's copy, its review and acceptance, undo in a chat), and
 * the desktop app carries its own git (dugite's build, as GitHub Desktop does). A git the user installed wins: it has
 * their settings. Without one, the core and everything it starts get the bundled git first in PATH.
 */
export function bundledGitEnv(gitDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Record<string, string> {
  const win = platform === "win32";
  const bins = win ? [join(gitDir, "cmd"), join(gitDir, "mingw64", "bin"), join(gitDir, "usr", "bin")] : [join(gitDir, "bin")];
  const pathKey = win ? (Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path") : "PATH";
  const vars: Record<string, string> = {
    [pathKey]: [...bins, env[pathKey] ?? ""].filter(Boolean).join(delimiter),
    GIT_EXEC_PATH: win ? join(gitDir, "mingw64", "libexec", "git-core") : join(gitDir, "libexec", "git-core"),
  };
  if (!win) {
    vars.GIT_CONFIG_SYSTEM = join(gitDir, "etc", "gitconfig");
    vars.GIT_TEMPLATE_DIR = join(gitDir, "share", "git-core", "templates");
    if (platform === "linux") {
      vars.PREFIX = gitDir;
      vars.GIT_SSL_CAINFO = join(gitDir, "ssl", "cacert.pem");
    }
  }
  return vars;
}

/** True when a git is installed on the system and answers. */
export function systemGit(): boolean {
  const res = spawnSync("git", ["--version"], { windowsHide: true, timeout: 10_000 });
  return res.status === 0;
}

/** The environment the core starts with: the bundled git when the system has none and the app carries one. */
export function coreGitEnv(gitDir: string): Record<string, string> {
  if (systemGit() || !existsSync(gitDir)) return {};
  return bundledGitEnv(gitDir, process.platform, process.env);
}
