import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledGitEnv } from "../src/git-env";

const gitDir = resolve(__dirname, "../../../node_modules/dugite/git");

describe("the git the app carries", () => {
  it("puts the bundled git first and points git to its own parts", () => {
    const vars = bundledGitEnv("/opt/artel/git", "linux", { PATH: "/usr/bin" });
    expect(vars.PATH!.startsWith(join("/opt/artel/git", "bin"))).toBe(true);
    expect(vars.PATH!.endsWith("/usr/bin")).toBe(true);
    expect(vars).toMatchObject({ PREFIX: "/opt/artel/git", GIT_EXEC_PATH: join("/opt/artel/git", "libexec", "git-core") });
  });

  // The real thing: the copy dugite downloaded works with nothing installed, in a clean environment.
  it.runIf(process.platform === "win32" && existsSync(gitDir))("runs on Windows from its own folder", () => {
    const vars = bundledGitEnv(gitDir, "win32", { Path: "C:\\Windows\\System32" });
    const env = { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", ...vars };
    const dir = mkdtempSync(join(tmpdir(), "artel-git-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir, env });
      expect(existsSync(join(dir, ".git"))).toBe(true);
      expect(execFileSync("git", ["--version"], { env }).toString()).toMatch(/git version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
