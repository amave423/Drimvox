import { tool, type ToolSet } from "ai";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";

type Found = { tool: string; ran: string; ok: boolean; summary: string };

function exec(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 180_000, signal, windowsHide: true, shell: process.platform === "win32", maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 127 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** npm audit's report, short: how many by severity, and each vulnerable package with its fix. */
export function npmSummary(json: string): string | null {
  try {
    const r = JSON.parse(json) as {
      metadata?: { vulnerabilities?: Record<string, number> };
      vulnerabilities?: Record<string, { severity: string; via: (string | { title?: string; url?: string })[]; fixAvailable: boolean | { name: string; version: string; isSemVerMajor?: boolean } }>;
    };
    const counts = r.metadata?.vulnerabilities ?? {};
    const total = Object.entries(counts).filter(([k]) => k !== "total").reduce((s, [, n]) => s + n, 0);
    if (!total) return "No known vulnerabilities.";
    const order = ["critical", "high", "moderate", "low", "info"];
    const lines = Object.entries(r.vulnerabilities ?? {})
      .sort((a, b) => order.indexOf(a[1].severity) - order.indexOf(b[1].severity))
      .slice(0, 30)
      .map(([name, v]) => {
        const why = v.via.find((x): x is { title?: string } => typeof x === "object")?.title ?? `through ${v.via.filter((x) => typeof x === "string").join(", ")}`;
        const fix = v.fixAvailable === true ? "fix: npm audit fix" : v.fixAvailable ? `fix: ${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? " (major update: check it)" : ""}` : "no fix yet";
        return `- [${v.severity}] ${name}: ${why} — ${fix}`;
      });
    return `${order.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(", ")}\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

/**
 * Known vulnerabilities in a project's dependencies (docs/specs/tools.md, asked for): each ecosystem's own audit, run in
 * the folder — npm, pip-audit, govulncheck, cargo audit, composer audit; fix updates what can be updated safely.
 */
export function auditTools(folder: string, hooks: Pick<ToolHooks, "onCall">): ToolSet {
  return {
    audit_dependencies: tool({
      description:
        "Check the project's dependencies for known vulnerabilities with each ecosystem's own audit (npm, Python, Go, Rust, PHP) and say what to update. fix: true also applies the safe updates (npm audit fix), then checks again.",
      inputSchema: z.object({ fix: z.boolean().optional() }),
      execute: async ({ fix }, o: { abortSignal?: AbortSignal }) => {
        hooks.onCall({ callId: randomUUID(), name: "audit_dependencies", input: fix ? "fix" : "" });
        const has = (name: string) => existsSync(join(folder, name));
        const found: Found[] = [];
        if (has("package.json")) {
          if (fix) await exec("npm", ["audit", "fix", "--no-fund"], folder, o.abortSignal);
          const r = await exec("npm", ["audit", "--json", "--no-fund"], folder, o.abortSignal);
          const summary = npmSummary(r.stdout);
          found.push({ tool: "npm", ran: "npm audit", ok: summary !== null, summary: summary ?? (r.stderr.trim().split("\n").slice(-3).join("\n") || "npm audit gave no report (install the dependencies first: npm install).") });
        }
        if (has("requirements.txt") || has("pyproject.toml")) {
          const args = has("requirements.txt") ? ["-r", "requirements.txt"] : [];
          let r = await exec("pip-audit", args, folder, o.abortSignal);
          if (r.code === 127 || /not recognized|not found/i.test(r.stderr)) r = await exec("python", ["-m", "pip_audit", ...args], folder, o.abortSignal);
          const missing = /No module named pip_audit|not recognized|not found/i.test(r.stderr);
          found.push({ tool: "Python", ran: "pip-audit", ok: !missing, summary: missing ? "pip-audit is not installed: pip install pip-audit, then check again." : (r.stdout || r.stderr).trim().slice(0, 4000) || "No known vulnerabilities." });
        }
        if (has("go.mod")) {
          const r = await exec("govulncheck", ["./..."], folder, o.abortSignal);
          const missing = r.code === 127 || /not recognized|not found/i.test(r.stderr);
          found.push({ tool: "Go", ran: "govulncheck", ok: !missing, summary: missing ? "govulncheck is not installed: go install golang.org/x/vuln/cmd/govulncheck@latest" : (r.stdout || r.stderr).trim().slice(0, 4000) });
        }
        if (has("Cargo.toml")) {
          const r = await exec("cargo", ["audit"], folder, o.abortSignal);
          const missing = /no such (sub)?command|not recognized/i.test(r.stderr);
          found.push({ tool: "Rust", ran: "cargo audit", ok: !missing, summary: missing ? "cargo-audit is not installed: cargo install cargo-audit" : (r.stdout || r.stderr).trim().slice(0, 4000) });
        }
        if (has("composer.json")) {
          const r = await exec("composer", ["audit"], folder, o.abortSignal);
          found.push({ tool: "PHP", ran: "composer audit", ok: r.code !== 127, summary: (r.stdout || r.stderr).trim().slice(0, 4000) });
        }
        if (!found.length) return "No dependency files here (package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, composer.json).";
        return found.map((f) => `${f.tool} (${f.ran}):\n${f.summary}`).join("\n\n");
      },
    }),
  };
}
