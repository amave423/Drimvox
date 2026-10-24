// Agent part of the live check: a real model gets a tiny real task in a temporary git repository.
import type { DiffFile, TaskEvent, TaskView } from "@drimvox/shared";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

const TASK =
  "В math.js есть функция add. Добавь функцию subtract(a, b) и тест для неё в math.test.js. " +
  "Тесты запускаются командой `node --test`. Убедись, что все тесты проходят.";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "drimvox-live-repo-"));
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  writeFileSync(join(dir, "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(
    join(dir, "math.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./math.js";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n',
  );
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Live Check");
  git(dir, "config", "user.email", "live@example.com");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Initial commit");
  return dir;
}

/** Returns true when the agent finished, the change was accepted and `node --test` passes in the project. */
export async function checkAgent(api: Api, providerId: string, model: string, log: (...p: unknown[]) => void): Promise<boolean> {
  const repo = makeProject();
  try {
    const project = (await api("POST", "/projects", { path: repo })).body;
    // The whole pipeline: interview, spec, tests first, code, Drimvox's own checks.
    const stages = { interview: true, spec: true, approveSpec: true, testsFirst: true };
    const started = await api("POST", `/projects/${project.id}/tasks`, { task: TASK, providerId, model, stages });
    if (started.status !== 201) {
      log("agent: could not start", started.status, started.body);
      return false;
    }
    const id = (started.body as TaskView).id;

    let task: TaskView = started.body;
    const until = Date.now() + 8 * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      task = (await api("GET", `/tasks/${id}`)).body;
      if (task.status === "running") continue;
      // The live check answers like a user who trusts the recommendations, and never grants risky commands.
      if (task.pendingApproval) await api("POST", `/tasks/${id}/approvals/${task.pendingApproval.id}`, { allow: false });
      else if (task.status === "waiting" && task.statusReason === "questions") {
        log("  questions:", task.questions.map((q) => q.question).join(" | "));
        const answers = task.questions.map((q) => ({ id: q.id, answer: q.options[q.recommended ?? 0]?.label ?? "As you see fit" }));
        await api("POST", `/tasks/${id}/answers`, { answers });
      } else if (task.status === "waiting" && task.statusReason === "spec_review") {
        log("  spec checks:", task.checks, "plan:", task.plan);
        await api("POST", `/tasks/${id}/spec`, { spec: task.spec, checks: task.checks });
      } else break;
    }

    const events = (await api("GET", `/tasks/${id}/events`)).body as TaskEvent[];
    const checks = events.filter((e) => e.kind === "check").map((e) => `${e.data.phase}: ${e.data.command} → ${e.data.ok ? "green" : "red"}`);
    log("  checks run by Drimvox:", checks.join("; ") || "none");
    const actions = events
      .filter((e) => e.kind === "tool_call")
      .map((e) => `${e.data.name}${e.data.input?.path ? ` ${e.data.input.path}` : e.data.input?.command ? ` "${e.data.input.command}"` : ""}`);
    log(`agent ${model}:`, {
      status: task.status,
      reason: task.statusReason,
      steps: task.steps,
      costUsd: Number(task.costUsd.toFixed(6)),
      summary: task.summary,
      commit: task.commitMessage,
    });
    log("  actions:", actions.join(" → "));
    const lastStatus = events.filter((e) => e.kind === "status").at(-1);
    if (task.status === "failed") log("  error:", lastStatus?.data);
    if (task.status !== "review") return false;

    const diff = (await api("GET", `/tasks/${id}/diff`)).body as DiffFile[];
    log("  changed:", diff.map((f) => `${f.path} +${f.added} -${f.removed}`).join(", "));
    const accepted = await api("POST", `/tasks/${id}/accept`, {});
    if (accepted.status !== 200) {
      log("  accept refused:", accepted.body);
      return false;
    }
    try {
      execFileSync(process.execPath, ["--test"], { cwd: repo, stdio: "pipe" });
      log("  node --test in the project after accept: passed;", git(repo, "log", "--format=%s", "-1"));
      return true;
    } catch (err) {
      log("  node --test in the project after accept: FAILED", String((err as { stdout?: Buffer }).stdout ?? err).slice(0, 500));
      return false;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
