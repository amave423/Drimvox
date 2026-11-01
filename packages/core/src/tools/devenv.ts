import { tool, type ToolSet } from "ai";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";

/** What a project may need, how to ask its version, and how to install it on Windows (winget) and elsewhere. */
const CHECKS: { name: string; cmd: string; args: string[]; win: string; other: string }[] = [
  { name: "Node.js", cmd: "node", args: ["--version"], win: "winget install OpenJS.NodeJS.LTS", other: "https://nodejs.org" },
  { name: "Python", cmd: process.platform === "win32" ? "python" : "python3", args: ["--version"], win: "winget install Python.Python.3.12", other: "the system's package manager (python3)" },
  { name: "Git", cmd: "git", args: ["--version"], win: "winget install Git.Git", other: "the system's package manager (git)" },
  { name: ".NET SDK", cmd: "dotnet", args: ["--list-sdks"], win: "winget install Microsoft.DotNet.SDK.8", other: "https://dotnet.microsoft.com/download" },
  { name: "Java (JDK)", cmd: "javac", args: ["-version"], win: "winget install EclipseAdoptium.Temurin.21.JDK", other: "the system's package manager (openjdk-21-jdk)" },
  { name: "Maven", cmd: "mvn", args: ["-v"], win: "winget install Apache.Maven", other: "the system's package manager (maven)" },
  { name: "Gradle", cmd: "gradle", args: ["-v"], win: "winget install Gradle.Gradle", other: "https://gradle.org/install (or the project's ./gradlew)" },
  { name: "Go", cmd: "go", args: ["version"], win: "winget install GoLang.Go", other: "https://go.dev/dl" },
  { name: "Rust", cmd: "cargo", args: ["--version"], win: "winget install Rustlang.Rustup", other: "https://rustup.rs" },
  { name: "PHP", cmd: "php", args: ["-v"], win: "winget install PHP.PHP.8.3", other: "the system's package manager (php)" },
  { name: "Docker", cmd: "docker", args: ["--version"], win: "winget install Docker.DockerDesktop", other: "https://docs.docker.com/get-docker" },
];

function version(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout: 15_000, windowsHide: true, shell: process.platform === "win32" }, (err, stdout, stderr) => {
      const text = `${stdout}\n${stderr}`.trim();
      if (err && !text) return resolve(null);
      if (err && /not recognized|not found|No such file/i.test(text)) return resolve(null);
      resolve(text.split("\n").filter(Boolean).slice(0, 3).join("; ").slice(0, 200) || null);
    }),
  );
}

/**
 * What is installed for development on this computer (docs/specs/tools.md, asked for with desktop apps in C# and Java):
 * each tool's version, or how to install it. The agent checks this before building instead of failing on a missing SDK.
 */
export function devEnvironmentTools(hooks: Pick<ToolHooks, "onCall">): ToolSet {
  return {
    dev_environment: tool({
      description: "What is installed for development on this computer: Node.js, Python, Git, .NET SDK, Java JDK, Maven, Gradle, Go, Rust, PHP, Docker — each with its version, or how to install it. Check it before building a project that needs one.",
      inputSchema: z.object({}),
      execute: async () => {
        hooks.onCall({ callId: randomUUID(), name: "dev_environment", input: "" });
        const found = await Promise.all(CHECKS.map(async (c) => ({ c, v: await version(c.cmd, c.args) })));
        const lines = found.map(({ c, v }) => (v ? `${c.name}: ${v}` : `${c.name}: not installed — ${process.platform === "win32" ? c.win : c.other}`));
        return `${process.platform} ${process.arch}\n${lines.join("\n")}`;
      },
    }),
  };
}
