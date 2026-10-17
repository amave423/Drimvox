// Benchmark: a real model does the reference tasks of docs/specs/backlog-loop.md through the real core API, and
// the table says whether each one got done, in how many steps and failed calls, minutes and rubles.
// `npm run bench` runs all; `npm run bench -- --only=pomodoro` one; `--model=...` another RouterAI model;
// `--budget=1.5` the task budget in dollars. Keys come from .env and never reach the output.
// The interview is answered with the recommended options, specs and stages are approved, risky commands denied.
// Each run's events go to .bench/<task>-<time>.json for replay tests.
import { startServer } from "@artel/core";
import { PAGE_HEIGHT_SCRIPT, type TaskEvent, type TaskView } from "@artel/shared";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";

interface BenchTask {
  name: string;
  task: string;
  /** Files of the project before the task. */
  files: Record<string, string>;
  /** Whether the result does what was asked, checked in the project folder after the task is accepted. */
  done(dir: string): boolean;
  minutes: number;
}

const BUGGY = "export function average(list) {\n  let sum = 0;\n  for (let i = 1; i < list.length; i++) sum += list[i];\n  return sum / list.length;\n}\n";
const AVERAGE_TEST =
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { average } from "./stats.js";\n\n' +
  'test("average of three", () => assert.equal(average([1, 2, 3]), 2));\ntest("average of one", () => assert.equal(average([5]), 5));\n';

const tasks: BenchTask[] = [
  {
    name: "bugfix",
    task: "Тесты в проекте падают (`node --test`). Найди и исправь ошибку в коде, тесты не меняй.",
    files: { "package.json": '{ "type": "module" }\n', "stats.js": BUGGY, "stats.test.js": AVERAGE_TEST },
    // The original test, not one the agent may have changed, passes.
    done: (dir) => {
      writeFileSync(join(dir, "stats.test.js"), AVERAGE_TEST);
      return passes(dir, process.execPath, ["--test"]);
    },
    minutes: 15,
  },
  {
    name: "pomodoro",
    task: "Сделай одностраничный сайт-таймер помодоро: 25 минут работы, 5 минут отдыха, кнопки старт, пауза и сброс, счётчик завершённых помидоров. Простые HTML, CSS и JS без сборки.",
    files: { "README.md": "# Pomodoro\n" },
    done: (dir) => existsSync(join(dir, "index.html")) && /<button/i.test(readFileSync(join(dir, "index.html"), "utf8") + allJs(dir)),
    minutes: 30,
  },
  {
    name: "sky",
    task: "сделай мне красивый анимированный сайт, но с таким внешним видом чтобы казался каким то очень серьезным сайтом",
    files: { "README.md": "# Site\n" },
    done: (dir) => existsSync(join(dir, "index.html")),
    minutes: 120,
  },
];

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const model = arg("model") ?? "deepseek/deepseek-v4.1-flash";
const budgetUsd = Number(arg("budget") ?? "2");
const only = arg("only");

const env = { ...readDotEnv(join(process.cwd(), ".env")), ...process.env };
const key = env.ROUTERAI_API_KEY;
if (!key) throw new Error("ROUTERAI_API_KEY is not in .env");
const redact = (text: string) => text.split(key).join("***");
const log = (text: string) => console.log(redact(text));

let browser: Promise<Browser> | null = null;
async function screenshot(url: string, size: { width: number; height: number }): Promise<Buffer> {
  browser ??= chromium.launch({ channel: "msedge", headless: true });
  const page = await (await browser).newPage({ viewport: size });
  try {
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(500);
    const height = Math.min(Number(await page.evaluate(PAGE_HEIGHT_SCRIPT)), 8000);
    if (height > size.height) await page.setViewportSize({ width: size.width, height });
    return await page.screenshot({ type: "png", fullPage: true });
  } finally {
    await page.close();
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "artel-bench-"));
const token = randomBytes(16).toString("hex");
const server = await startServer({ token, secretKey: randomBytes(32), dataDir, version: "bench", screenshot });
const base = `http://127.0.0.1:${server.port}/api`;
const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const balance = async (): Promise<number | null> => {
  const res = await fetch("https://routerai.ru/api/v1/credits", { headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { data?: { credits?: number } } | null;
  return body?.data?.credits ?? null;
};

const out = join(process.cwd(), ".bench");
mkdirSync(out, { recursive: true });
const rows: string[] = [];
try {
  const provider = (await api("POST", "/providers", { preset: "routerai", apiKey: key })).body;
  await api("PATCH", "/settings", { visionModel: { providerId: provider.id, model }, agentBudgetUsd: budgetUsd });
  for (const t of tasks.filter((t) => !only || t.name === only)) rows.push(await run(t, provider.id));
} finally {
  await server.close();
  const opened = browser as Promise<Browser> | null;
  if (opened) await (await opened).close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
log(`\nmodel ${model}, budget $${budgetUsd}\n| task | done | status | steps | failed calls | minutes | ₽ |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}`);

async function run(t: BenchTask, providerId: string): Promise<string> {
  const dir = makeProject(t.files);
  const before = await balance();
  const started = Date.now();
  const project = (await api("POST", "/projects", { path: dir })).body;
  const created = await api("POST", `/projects/${project.id}/tasks`, { task: t.task, providerId, model });
  if (created.status !== 201) throw new Error(`${t.name}: ${JSON.stringify(created.body)}`);
  const id = (created.body as TaskView).id;
  log(`\n=== ${t.name} (${id})`);

  let task: TaskView = created.body;
  let seen = 0;
  for (const until = started + t.minutes * 60_000; Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, 2000));
    task = (await api("GET", `/tasks/${id}`)).body;
    const events = (await api("GET", `/tasks/${id}/events`)).body as TaskEvent[];
    for (const e of events.slice(seen)) if (["phase", "status", "acceptance", "milestone"].includes(e.kind)) log(`  ${e.kind} ${JSON.stringify(e.data).slice(0, 160)}`);
    seen = events.length;
    if (task.status === "running" || task.status === "queued") continue;
    if (task.pendingApproval) await api("POST", `/tasks/${id}/approvals/${task.pendingApproval.id}`, { allow: false });
    else if (task.status === "waiting" && task.statusReason === "questions") {
      const answers = task.questions.map((q) => ({ id: q.id, answer: q.options[q.recommended ?? 0]?.label ?? "Как считаешь лучше" }));
      await api("POST", `/tasks/${id}/answers`, { answers });
    } else if (task.status === "waiting" && task.statusReason === "spec_review") {
      await api("POST", `/tasks/${id}/spec`, { spec: task.spec, checks: task.checks });
    } else if (task.status === "waiting" && task.statusReason === "milestone_review") {
      await api("POST", `/tasks/${id}/continue`, {});
    } else break;
  }

  const events = (await api("GET", `/tasks/${id}/events`)).body as TaskEvent[];
  writeFileSync(join(out, `${t.name}-${new Date(started).toISOString().replace(/[:.]/g, "-")}.json`), redact(JSON.stringify({ model, task, events })));
  const failed = events.filter((e) => e.kind === "tool_result" && !(e.data as { ok: boolean }).ok).length;
  const reachedReview = task.status === "review";
  if (task.status === "running" || task.status === "waiting") await api("POST", `/tasks/${id}/stop`, {});
  const accepted = reachedReview && (await api("POST", `/tasks/${id}/accept`, {})).status === 200;
  const done = accepted && t.done(dir);
  const after = await balance();
  const rub = before !== null && after !== null ? (before - after).toFixed(1) : "?";
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return `| ${t.name} | ${done ? "yes" : "no"} | ${task.status}${task.statusReason ? `/${task.statusReason}` : ""} | ${task.steps} | ${failed} | ${minutes} | ${rub} |`;
}

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "artel-bench-repo-"));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Bench");
  git("config", "user.email", "bench@example.com");
  git("add", "-A");
  git("commit", "-q", "-m", "Start");
  return dir;
}

function passes(cwd: string, file: string, args: string[]): boolean {
  try {
    execFileSync(file, args, { cwd, stdio: "pipe", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

function allJs(dir: string): string {
  return execFileSync("git", ["ls-files", "*.js"], { cwd: dir, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

function readDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1]!, m[2]!.replace(/^["']|["']$/g, "")]),
  );
}
