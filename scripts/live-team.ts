// Team part of the live check (`--team`): a real lead model plans two subtasks and real workers do them.
import type { TaskView } from "@drimvox/shared";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

const GOAL =
  "Создай два независимых модуля, каждый со своим тестом: strings.js с функцией capitalize(s) " +
  "(первая буква заглавная) и numbers.js с функцией clamp(x, min, max). Тесты запускаются командой `node --test`.";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "drimvox-live-team-"));
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  writeFileSync(join(dir, "README.md"), "# Utils\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Live Check");
  git(dir, "config", "user.email", "live@example.com");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Initial commit");
  return dir;
}

/** Returns true when the team reached review, the goal was accepted and `node --test` passes in the project. */
export async function checkTeam(api: Api, providerId: string, model: string, log: (...p: unknown[]) => void): Promise<boolean> {
  const repo = makeProject();
  try {
    const project = (await api("POST", "/projects", { path: repo })).body;
    const stages = { interview: false, spec: true, approveSpec: true, testsFirst: false };
    const started = await api("POST", `/projects/${project.id}/tasks`, { task: GOAL, providerId, model, team: { providerId, model }, stages });
    if (started.status !== 201) {
      log("team: could not start", started.status, started.body);
      return false;
    }
    const id = (started.body as TaskView).id;

    let goal: TaskView = started.body;
    const until = Date.now() + 15 * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1500));
      goal = (await api("GET", `/tasks/${id}`)).body;
      if (goal.status === "waiting" && goal.statusReason === "plan_review") {
        for (const s of goal.plannedSubtasks) {
          log(`  subtask ${s.id}${s.dependsOn.length ? ` (after ${s.dependsOn.join(", ")})` : ""}:`, s.checks);
        }
        log("  goal checks:", goal.checks);
        await api("POST", `/tasks/${id}/plan`, { spec: goal.spec, checks: goal.checks, subtasks: goal.plannedSubtasks });
        continue;
      }
      // Like the solo check: risky commands are always refused.
      for (const sub of goal.subtasks.filter((s) => s.status === "waiting" && s.statusReason === "approval")) {
        const view = (await api("GET", `/tasks/${sub.taskId}`)).body as TaskView;
        if (view.pendingApproval) await api("POST", `/tasks/${sub.taskId}/approvals/${view.pendingApproval.id}`, { allow: false });
      }
      if (goal.status === "running" || (goal.status === "waiting" && goal.statusReason === "subtask_waiting")) continue;
      break;
    }

    log(`team ${model}:`, {
      status: goal.status,
      reason: goal.statusReason,
      steps: goal.steps,
      costUsd: Number(goal.costUsd.toFixed(6)),
      subtasks: goal.subtasks.map((s) => `${s.id}: ${s.status}${s.statusReason ? `/${s.statusReason}` : ""}`).join(", "),
    });
    const events = (await api("GET", `/tasks/${id}/events`)).body as { kind: string; data: any }[];
    const flow = events
      .filter((e) => e.kind === "subtask" || (e.kind === "check" && e.data.phase === "integration"))
      .map((e) => (e.kind === "subtask" ? `${e.data.id} ${e.data.action}` : `checks ${e.data.ok ? "green" : "red"}`));
    log("  flow:", flow.join(" → "));
    if (goal.status !== "review") return false;

    const accepted = await api("POST", `/tasks/${id}/accept`, {});
    if (accepted.status !== 200) {
      log("  accept refused:", accepted.body);
      return false;
    }
    try {
      execFileSync(process.execPath, ["--test"], { cwd: repo, stdio: "pipe" });
      log("  node --test in the project after accept: passed;", git(repo, "ls-files").split("\n").join(", "));
      return true;
    } catch (err) {
      log("  node --test in the project after accept: FAILED", String((err as { stdout?: Buffer }).stdout ?? err).slice(0, 500));
      return false;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
