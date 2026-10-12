import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCli, setCliCommands } from "../src/cli/resolve";

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
  setCliCommands(undefined);
});

/** A folder like %APPDATA%\npm, under a non-Latin name as on the author's machine. */
function npmDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "artel-cli-")), "Артём npm");
  mkdirSync(dir, { recursive: true });
  process.env.PATH = dir;
  return dir;
}

describe.runIf(process.platform === "win32")("finding a CLI on Windows", () => {
  it("starts the program an npm wrapper runs, without a shell", () => {
    const dir = npmDir();
    const exe = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    mkdirSync(join(exe, ".."), { recursive: true });
    writeFileSync(exe, "");
    writeFileSync(join(dir, "claude"), "#!/bin/sh\n");
    writeFileSync(join(dir, "claude.cmd"), '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
    expect(resolveCli("claude-code")).toEqual([exe]);
  });

  it("runs a script wrapper with Node", () => {
    const dir = npmDir();
    const script = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(script, "");
    writeFileSync(join(dir, "node.exe"), "");
    writeFileSync(join(dir, "codex.cmd"), '@SETLOCAL\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    expect(resolveCli("codex")).toEqual([join(dir, "node.exe"), script]);
  });

  it("knows when nothing is installed", () => {
    npmDir();
    expect(resolveCli("gemini-cli")).toBeNull();
  });
});
