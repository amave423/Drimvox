// Project part of the live check (docs/specs/project-work.md): a real model interviews, writes the plan, and after "Go"
// works alone in a temporary project until it calls finish_work, with its own checklist.
import type { ChatWithMessages, ProjectWorkView, TaskView } from "@artel/shared";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

const TASK =
  "Сделай в slug.js функцию slugify(text): строка в нижнем регистре, пробелы и знаки — дефисы, русские буквы — " +
  "латиницей (Привет мир → privet-mir). Тесты в slug.test.js, запуск командой `node --test`. Интерфейс не нужен.";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "artel-live-project-"));
  writeFileSync(join(dir, "package.json"), '{ "type": "module", "scripts": { "test": "node --test" } }\n');
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Live Check");
  git(dir, "config", "user.email", "live@example.com");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Initial commit");
  return dir;
}

/** Returns true when the run ended with finish_work, every checklist item done, and `node --test` passes. */
export async function checkProject(api: Api, providerId: string, model: string, log: (...p: unknown[]) => void): Promise<boolean> {
  const repo = makeProject();
  const started = Date.now();
  try {
    const project = (await api("POST", "/projects", { path: repo })).body;
    const ref = { providerId, model };
    const plan = await api("POST", `/projects/${project.id}/work/plan`, { task: TASK, models: { interview: ref, plan: ref, work: ref, strong: null } });
    if (plan.status !== 201) {
      log("project: could not start", plan.status, plan.body);
      return false;
    }
    const taskId = (plan.body as TaskView).id;
    let work: ProjectWorkView = (await api("GET", `/projects/${project.id}/work`)).body;
    const until = Date.now() + 20 * 60_000;
    let went = false;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1500));
      work = (await api("GET", `/projects/${project.id}/work`)).body;
      const task: TaskView = (await api("GET", `/tasks/${taskId}`)).body;
      // The live check answers like a user who trusts the recommendations, and never grants risky commands.
      if (task.status === "waiting" && task.statusReason === "questions") {
        log("  questions:", task.questions.map((q) => q.question).join(" | "));
        const answers = task.questions.map((q) => ({ id: q.id, answer: q.options[q.recommended ?? 0]?.label ?? "As you see fit" }));
        await api("POST", `/tasks/${taskId}/answers`, { answers });
      } else if (work.status === "ready" && !went) {
        log("  plan:", work.plan?.context, "| steps:", work.plan?.steps?.join("; "));
        went = true;
        await api("POST", `/projects/${project.id}/work/start`, { budgetUsd: 0.3, hours: 0.3 });
      } else if (work.status === "running" && work.waitingApproval && work.chatId) {
        const chat: ChatWithMessages = (await api("GET", `/chats/${work.chatId}`)).body;
        for (const a of chat.approvals) {
          log("  denied:", a.tool);
          await api("POST", `/chats/${work.chatId}/approvals/${a.id}`, { allow: false });
        }
      } else if (["done", "paused", "stopped"].includes(work.status) || task.status === "failed") break;
    }
    if (work.status === "running") await api("POST", `/projects/${project.id}/work/stop`);

    const chat: ChatWithMessages | null = work.chatId ? (await api("GET", `/chats/${work.chatId}`)).body : null;
    const actions = (chat?.messages ?? []).filter((m) => m.role === "assistant").flatMap((m) => m.activity.map((a) => `${a.name}${a.input ? ` ${a.input.slice(0, 60)}` : ""}`));
    log(`project ${model}:`, {
      status: work.status,
      reason: work.reason,
      detail: work.detail,
      minutes: Number(((Date.now() - started) / 60_000).toFixed(1)),
      spentUsd: Number(work.spentUsd.toFixed(5)),
      actions: work.actions,
      checklist: work.checklist.map((i) => `${i.done ? "✓" : "·"} ${i.text}`),
      questions: work.questions.map((q) => q.question),
    });
    log("  actions:", actions.join(" → "));
    log("  last answer:", chat?.messages.at(-1)?.content.slice(0, 400));
    let tests = false;
    try {
      execFileSync("node", ["--test"], { cwd: repo, stdio: "pipe", timeout: 60_000 });
      tests = true;
    } catch (err) {
      log("  node --test failed:", String((err as { stdout?: Buffer }).stdout ?? err).slice(0, 800));
    }
    return work.status === "done" && work.checklist.every((i) => i.done) && tests;
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
