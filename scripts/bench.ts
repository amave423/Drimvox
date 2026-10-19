// Benchmark: a real model does the reference tasks of docs/specs/backlog-loop.md through the real core API, and
// the table says whether each one got done, in how many steps and failed calls, minutes and rubles.
// `npm run bench` runs all; `npm run bench -- --only=pomodoro` one; `--model=...` another RouterAI model;
// `--budget=1.5` the task budget in dollars. Keys come from .env and never reach the output.
// The interview is answered with the recommended options, specs and stages are approved, risky commands denied.
// Each run's events go to .bench/<task>-<time>.json for replay tests.
import { startServer } from "@artel/core";
import { PAGE_HEIGHT_SCRIPT, type MessageView, type StreamEvent, type TaskEvent, type TaskView } from "@artel/shared";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";

interface BenchTask {
  name: string;
  task: string;
  /** For the new flow: a task put straight into the list, without the interview. */
  item?: { title: string; done: string[] };
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
    item: { title: "Почини падающие тесты", done: ["`node --test` проходит", "Сами тесты не изменены, исправлен код"] },
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
  {
    // A bigger project: planned into a list, its first task (the MVP) done in one conversation.
    name: "kanban",
    task:
      "Сделай канбан-доску в браузере: колонки «Надо», «В работе», «Готово»; карточки можно добавлять, править, удалять " +
      "и перетаскивать между колонками; поиск по карточкам; всё сохраняется в localStorage. Простые HTML, CSS и JS без " +
      "сборки; логику доски (добавить, переместить, найти) вынеси в модуль и покрой тестами на node --test.",
    files: { "README.md": "# Kanban\n", "package.json": '{ "type": "module" }\n' },
    done: (dir) => existsSync(join(dir, "index.html")) && passes(dir, process.execPath, ["--test"]),
    minutes: 60,
  },
];

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const model = arg("model") ?? "deepseek/deepseek-v4.1-flash";
const budgetUsd = Number(arg("budget") ?? "2");
const only = arg("only");
/** "new" (default): the task list and one agent loop; "old": a task through the old pipeline, for the baseline. */
const flow = arg("flow") === "old" ? "old" : "new";

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
  if (process.argv.includes("--tools")) rows.push(await checkTools(provider.id));
  else for (const t of tasks.filter((t) => !only || t.name === only)) rows.push(await run(t, provider.id));
} finally {
  await server.close();
  const opened = browser as Promise<Browser> | null;
  if (opened) await (await opened).close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
log(`\nmodel ${model}, budget $${budgetUsd}\n| task | flow | done | status | steps | failed calls | minutes | ₽ |\n|---|---|---|---|---|---|---|---|\n${rows.join("\n")}`);

async function run(t: BenchTask, providerId: string): Promise<string> {
  const dir = makeProject(t.files);
  const before = await balance();
  const started = Date.now();
  const project = (await api("POST", "/projects", { path: dir })).body;
  log(`
=== ${t.name} (${flow} flow)`);
  const tasks: { task: TaskView; events: TaskEvent[] }[] = [];
  const until = started + t.minutes * 60_000;

  if (flow === "old") {
    const created = await api("POST", `/projects/${project.id}/tasks`, { task: t.task, providerId, model });
    if (created.status !== 201) throw new Error(`${t.name}: ${JSON.stringify(created.body)}`);
    tasks.push(await drive((created.body as TaskView).id, until));
  } else {
    // docs/specs/backlog-loop.md: a small fix goes straight into the list; a project is planned, then its MVP is done.
    let itemId: string;
    if (t.item) {
      itemId = (await api("POST", `/projects/${project.id}/backlog`, { ...t.item, size: "S" })).body.id;
    } else {
      const plan = await api("POST", `/projects/${project.id}/backlog/plan`, { task: t.task, providerId, model });
      if (plan.status !== 201) throw new Error(`${t.name}: ${JSON.stringify(plan.body)}`);
      tasks.push(await drive((plan.body as TaskView).id, until));
      const items = (await api("GET", `/projects/${project.id}/backlog`)).body.items as { id: string; title: string }[];
      log(`  list: ${items.map((i) => i.title).join(" | ")}`);
      if (!items[0]) throw new Error(`${t.name}: no task list`);
      itemId = items[0].id;
    }
    // docs/specs/project-work.md: the task is a conversation in the project's folder, then accepted as one commit.
    const run = await api("POST", `/projects/${project.id}/backlog/run`, { ids: [itemId], providerId, model });
    if (run.status !== 201) throw new Error(`${t.name}: ${JSON.stringify(run.body)}`);
    const { chatId, message } = run.body as { chatId: string; message: string };
    const talk = await converse(chatId, message, until);
    const item = ((await api("GET", `/projects/${project.id}/backlog`)).body.items as { id: string; status: string }[]).find((i) => i.id === itemId);
    const accepted = item?.status === "review" && (await api("POST", `/projects/${project.id}/backlog/${itemId}/accept`, {})).status === 200;
    const done = accepted && t.done(dir);
    writeFileSync(join(out, `${t.name}-chat-${new Date(started).toISOString().replace(/[:.]/g, "-")}.json`), redact(JSON.stringify({ model, tasks, talk })));
    const after = await balance();
    const rub = before !== null && after !== null ? (before - after).toFixed(1) : "?";
    const minutes = ((Date.now() - started) / 60_000).toFixed(1);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const status = talk.answer?.status ?? "no answer";
    return `| ${t.name} | chat | ${done ? "yes" : "no"} | ${item?.status}/${status}${talk.answer?.error ? ` ${talk.answer.error.code}` : ""} | ${talk.tools} | ${talk.asked} | ${minutes} | ${rub} |`;
  }

  const last = tasks.at(-1)!.task;
  writeFileSync(join(out, `${t.name}-${flow}-${new Date(started).toISOString().replace(/[:.]/g, "-")}.json`), redact(JSON.stringify({ model, tasks })));
  const failed = tasks.reduce((n, x) => n + x.events.filter((e) => e.kind === "tool_result" && !(e.data as { ok: boolean }).ok).length, 0);
  const steps = tasks.reduce((n, x) => n + x.task.steps, 0);
  const reachedReview = last.status === "review";
  if (last.status === "running" || last.status === "waiting") await api("POST", `/tasks/${last.id}/stop`, {});
  const accepted = reachedReview && (await api("POST", `/tasks/${last.id}/accept`, {})).status === 200;
  const done = accepted && t.done(dir);
  const after = await balance();
  const rub = before !== null && after !== null ? (before - after).toFixed(1) : "?";
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return `| ${t.name} | ${flow} | ${done ? "yes" : "no"} | ${last.status}${last.statusReason ? `/${last.statusReason}` : ""} | ${steps} | ${failed} | ${minutes} | ${rub} |`;
}

/**
 * `--tools`: a skill and an MCP server in a chat with a folder, as a user sets them up. The answer has to open the skill,
 * add with the server's tool (asking first) and write the way the skill says.
 */
async function checkTools(providerId: string): Promise<string> {
  const dir = makeProject({ "README.md": "# Tools\n" });
  const before = await balance();
  const started = Date.now();
  await api("POST", "/skills", { name: "report-style", description: "Как писать итог", instructions: "Начинай ответ словами «Готово-готово:», дальше одно предложение." });
  const server = (await api("POST", "/mcp", { name: "demo", command: process.execPath, args: [join(process.cwd(), "packages", "core", "test", "mcp-server.mjs")] })).body;
  const status = (await api("GET", `/mcp/${server.id}/status`)).body;
  log(`=== tools\n  mcp: ${status.ok ? `${status.tools.length} tools` : JSON.stringify(status.error)}`);
  const chat = (await api("POST", "/chats", { providerId, model })).body;
  await api("PATCH", `/chats/${chat.id}/folder`, { folder: dir });
  const talk = await converse(chat.id, "Открой скилл report-style, сложи 17 и 25 инструментом add MCP-сервера demo и ответь по правилам скилла.", started + 5 * 60_000);
  log(`  answer: ${talk.text.trim().slice(0, 300)}`);
  const skill = talk.calls.some((c) => c.name === "use_skill");
  const mcp = talk.calls.some((c) => /demo.*add/.test(c.name));
  const styled = /Готово-готово/.test(talk.text) && /42/.test(talk.text);
  const after = await balance();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const rub = before !== null && after !== null ? (before - after).toFixed(1) : "?";
  return `| tools | skill ${skill ? "yes" : "no"}, mcp ${mcp ? "yes" : "no"}, style ${styled ? "yes" : "no"} | ${talk.answer?.status ?? "no answer"} | ${talk.tools} | ${talk.asked} | ${((Date.now() - started) / 60_000).toFixed(1)} | ${rub} |`;
}

interface Talk {
  answer: MessageView | null;
  text: string;
  /** Tool calls the answer made, and how many asked first. */
  tools: number;
  asked: number;
  calls: { name: string; input: string }[];
}

/**
 * One message in a chat, read from its stream like the window does. An MCP tool and a download are allowed (the
 * folder is a throwaway one); a push, a command outside the folder or on the system is not.
 */
async function converse(chatId: string, content: string, until: number): Promise<Talk> {
  const talk: Talk = { answer: null, text: "", tools: 0, asked: 0, calls: [] };
  const res = await fetch(`${base}/chats/${chatId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(Math.max(until - Date.now(), 1000)),
  });
  if (!res.ok || !res.body) throw new Error(`message: ${res.status} ${await res.text()}`);
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (!data) continue;
      const e = JSON.parse(data) as StreamEvent;
      if (e.type === "text") talk.text += e.text;
      else if (e.type === "tool") {
        talk.tools++;
        talk.calls.push({ name: e.name, input: e.input.slice(0, 200) });
        log(`  tool ${e.name} ${e.input.slice(0, 120)}`);
      } else if (e.type === "approval") {
        talk.asked++;
        log(`  asks ${e.server}/${e.tool}${e.reason ? ` (${e.reason})` : ""}`);
        await api("POST", `/chats/${chatId}/approvals/${e.id}`, { allow: !e.reason || e.reason === "download" });
      } else if (e.type === "done") talk.answer = e.message;
    }
  }
  return talk;
}

/** Answers like a user who trusts the recommendations, until the task needs nothing more or the time is up. */
async function drive(id: string, until: number): Promise<{ task: TaskView; events: TaskEvent[] }> {
  let task = (await api("GET", `/tasks/${id}`)).body as TaskView;
  let seen = 0;
  while (Date.now() < until) {
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
  return { task, events: (await api("GET", `/tasks/${id}/events`)).body as TaskEvent[] };
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
