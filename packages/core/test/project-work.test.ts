import { slug } from "../src/work/project-git";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { git, makeRepo } from "./git-repo";
import { setRetryDelays } from "../src/agent/pass";

// docs/specs/project-work.md: an interview, a plan, "Go", then one long run of the agent with its own checklist.
vi.setConfig({ testTimeout: 30_000 });

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider | undefined;
let folder: string;

beforeEach(() => {
  env = createTestEnv();
  folder = makeRepo({ "index.html": "<h1>Клиника</h1>\n" });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });
const noQuestions = call("ask_questions", { questions: [], understood: "Сайт клиники", unknown: [] });
const PLAN = {
  summary: "Сайт клиники: онлайн-запись к врачу и прайс-лист.",
  steps: ["Каталог", "Калькулятор", "Проверить страницы"],
  checks: ["Каталог открывается", "npm test"],
  pages: [{ url: "http://localhost:5173/", command: "npm run dev" }],
};
const writePlan = call("write_plan", PLAN);
const PRICED = [{ id: "coder", supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" } }];

/** A fake provider answering each model from its own queue: who wrote what shows in the requests. */
async function setup(queues: Record<string, FakeTurn[]>, models: Record<string, unknown>[] = [{ id: "coder", supported_parameters: ["tools"] }]) {
  fake = await startFakeProvider({
    key: KEY,
    models: [...models, ...Object.keys(queues).filter((id) => !models.some((m) => m.id === id)).map((id) => ({ id, supported_parameters: ["tools"] }))],
    // The code reviewer before the end answers from its own queue, "nothing found" by default.
    respond: (body) =>
      isReviewer(body) ? (queues.reviewer?.shift() ?? call("report_review", { issues: [], summary: "Проблем нет." })) : (queues[body.model]?.shift() ?? { text: "Готово." }),
  });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  const project = await (await env.call("POST", "/api/projects", { path: folder })).json();
  const ref = (model: string) => ({ providerId: provider.id as string, model });
  return { provider, project, ref };
}

const workOf = async (projectId: string) => (await (await env.call("GET", `/api/projects/${projectId}/work`)).json()) as any;

async function until(projectId: string, done: (w: any) => boolean) {
  for (let i = 0; i < 600; i++) {
    const w = await workOf(projectId);
    if (done(w)) return w;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`stuck: ${JSON.stringify(await workOf(projectId))}`);
}

/** The interview with one model, the plan with another; the plan waits for "Go". */
async function planned(s: Awaited<ReturnType<typeof setup>>, models: { interview?: string; plan?: string; work?: string; strong?: string | null } = {}) {
  const res = await env.call("POST", `/api/projects/${s.project.id}/work/plan`, {
    task: "Сайт клиники",
    models: {
      interview: s.ref(models.interview ?? "coder"),
      plan: s.ref(models.plan ?? "coder"),
      work: s.ref(models.work ?? "coder"),
      strong: models.strong ? s.ref(models.strong) : null,
    },
  });
  expect(res.status).toBe(201);
  return until(s.project.id, (w) => w.status === "ready");
}

const isReviewer = (body: any) => /You are the code reviewer/.test(JSON.stringify(body.messages?.[0]?.content ?? ""));
const requestsOf = (model: string) => fake!.requests.filter((r) => r.path === "/v1/chat/completions" && r.body.model === model && !isReviewer(r.body));

describe("work on a project", () => {
  it("ends the interview with a plan by the plan's model: its steps are the first checklist, its checks real commands", async () => {
    const s = await setup({ asker: [noQuestions], planner: [writePlan] });
    const work = await planned(s, { interview: "asker", plan: "planner" });
    expect(work.plan).toMatchObject({ context: PLAN.summary, steps: PLAN.steps, checks: ["npm test"] });
    expect(work.checklist).toEqual(PLAN.steps.map((text) => ({ text, done: false })));
    expect(requestsOf("asker")).toHaveLength(1);
    expect(requestsOf("planner")).toHaveLength(1);
    const task = await (await env.call("GET", `/api/tasks/${work.planTaskId}`)).json();
    expect(task).toMatchObject({ kind: "plan", status: "waiting", statusReason: "plan_ready" });
  });

  // Seen live: Claude Opus wrote "уточню ключевые моменты" without a question mark and without ask_questions, and the
  // interview the user had asked for was skipped for the plan.
  it("asks an interviewer that wrote no questions at all to hold the interview", async () => {
    const asked = call("ask_questions", {
      questions: [{ id: "city", question: "Какой город сразу?", options: [{ label: "Москва" }, { label: "По геолокации" }], recommended: 1 }],
      understood: "Сайт погоды",
      unknown: [],
    });
    const s = await setup({ asker: [{ text: "Прежде чем начать, уточню ключевые моменты." }, asked], planner: [writePlan] });
    await env.call("POST", `/api/projects/${s.project.id}/work/plan`, {
      task: "Сайт погоды",
      models: { interview: s.ref("asker"), plan: s.ref("planner"), work: s.ref("coder"), strong: null },
    });
    const work = await until(s.project.id, (w) => w.status === "planning" && !!w.planTaskId);
    let task: any;
    for (let i = 0; i < 100; i++) {
      task = await (await env.call("GET", `/api/tasks/${work.planTaskId}`)).json();
      if (task.status === "waiting") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(task).toMatchObject({ status: "waiting", statusReason: "questions" });
    expect(task.questions.map((q: any) => q.question)).toEqual(["Какой город сразу?"]);
    expect(JSON.stringify(requestsOf("asker").at(-1)!.body.messages)).toContain("You have not asked anything yet");
    expect(requestsOf("planner")).toHaveLength(0);
  });

  // Seen live: Claude opened the design skill for the plan, and the free model that built the page never did.
  it("gives the work the skills the plan was made with, whole", async () => {
    mkdirSync(join(folder, ".drimvox", "skills", "frontend-design"), { recursive: true });
    writeFileSync(
      join(folder, ".drimvox", "skills", "frontend-design", "SKILL.md"),
      ["---", "name: frontend-design", "description: Distinctive interfaces", "---", "Never the template look: one bold idea.", ""].join("\n"),
    );
    const s = await setup({ asker: [noQuestions], planner: [call("use_skill", { name: "frontend-design" }), writePlan] });
    const work = await planned(s, { interview: "asker", plan: "planner" });
    expect(work.plan.skills).toEqual(["frontend-design"]);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status !== "running" && !!w.startedAt);
    expect(JSON.stringify(requestsOf("coder")[0]!.body.messages[0])).toContain("Never the template look: one bold idea.");
  });

  // Asked for: a small fix in an existing project should not start with a big interview.
  it("writes the plan at once with the plan's model for a small task, without an interview", async () => {
    const s = await setup({ asker: [noQuestions], planner: [writePlan] });
    const res = await env.call("POST", `/api/projects/${s.project.id}/work/plan`, {
      task: "Кнопка уезжает за край на телефоне",
      quick: true,
      models: { interview: s.ref("asker"), plan: s.ref("planner"), work: s.ref("planner"), strong: null },
    });
    expect(res.status).toBe(201);
    const work = await until(s.project.id, (w) => w.status === "ready");
    expect(work.plan).toMatchObject({ steps: PLAN.steps });
    expect(requestsOf("asker")).toHaveLength(0);
    expect(JSON.stringify(requestsOf("planner")[0]!.body.messages[0])).toContain("There was no interview");
  });

  // Seen live: an interviewer wrote its questions as text; they were lost and the plan came without them.
  it("asks an interviewer that wrote its questions as text to ask them properly", async () => {
    const asks = call("ask_questions", { questions: [{ id: "look", question: "Какой стиль?", options: [{ label: "Тёплый" }, { label: "Строгий" }] }], understood: "Сайт", unknown: [] });
    const s = await setup({ asker: [{ text: "Уточню: какой стиль вам ближе — тёплый или строгий?" }, asks] });
    await env.call("POST", `/api/projects/${s.project.id}/work/plan`, { task: "Сайт", models: { interview: s.ref("asker"), plan: s.ref("asker"), work: s.ref("asker"), strong: null } });
    const work = await until(s.project.id, (w) => !!w.planTaskId);
    let task: any;
    for (let i = 0; i < 200; i++) {
      task = await (await env.call("GET", `/api/tasks/${work.planTaskId}`)).json();
      if (task.status !== "running") break;
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(task).toMatchObject({ status: "waiting", statusReason: "questions" });
    expect(JSON.stringify(requestsOf("asker").at(-1)!.body.messages)).toContain("You wrote your questions as text");
  });

  // Seen live: DeepSeek wrote its questions with one "}" too many; the call failed and the interview was skipped.
  const QUESTIONS = { questions: [{ id: "look", question: "Какой стиль?", options: [{ label: "Тёплый" }, { label: "Строгий" }] }], understood: "Сайт", unknown: [] };
  async function interviewOf(s: Awaited<ReturnType<typeof setup>>) {
    await env.call("POST", `/api/projects/${s.project.id}/work/plan`, { task: "Сайт", models: { interview: s.ref("asker"), plan: s.ref("asker"), work: s.ref("asker"), strong: null } });
    const work = await until(s.project.id, (w) => !!w.planTaskId);
    let task: any;
    for (let i = 0; i < 200; i++) {
      task = await (await env.call("GET", `/api/tasks/${work.planTaskId}`)).json();
      if (task.status !== "running") break;
      await new Promise((r) => setTimeout(r, 30));
    }
    return task;
  }

  it("reads questions whose JSON has a bracket too many", async () => {
    const extra = JSON.stringify(QUESTIONS).replace(/\]\}$/, "}]}");
    const s = await setup({ asker: [{ toolCalls: [{ name: "ask_questions", args: {}, raw: extra }] }] });
    expect(await interviewOf(s)).toMatchObject({ status: "waiting", statusReason: "questions" });
    expect(requestsOf("asker")).toHaveLength(1);
  });

  it("asks again for questions it cannot read, instead of skipping the interview", async () => {
    const s = await setup({ asker: [{ toolCalls: [{ name: "ask_questions", args: {}, raw: '{"questions": [{"id": look}]' }] }, call("ask_questions", QUESTIONS)] });
    expect(await interviewOf(s)).toMatchObject({ status: "waiting", statusReason: "questions" });
    expect(JSON.stringify(requestsOf("asker").at(-1)!.body.messages)).toContain("could not be read");
  });

  // Seen live: Opus sent what is still open as one sentence; the call failed on its type and the interview was skipped.
  it("takes what is still open written as one sentence", async () => {
    const s = await setup({ asker: [call("ask_questions", { ...QUESTIONS, unknown: "Стиль сайта и цены доставки" })] });
    expect(await interviewOf(s)).toMatchObject({ status: "waiting", statusReason: "questions" });
    expect(requestsOf("asker")).toHaveLength(1);
  });

  // Seen live: "The service is temporarily busy" ended a plan for good; a moment later it would have worked.
  it("tries a busy provider again a moment later instead of failing the interview", async () => {
    setRetryDelays([10, 10, 10]);
    const busy = { fail: { status: 400, message: "The service is temporarily busy. Please retry in a few seconds." } };
    const s = await setup({ asker: [busy, busy, call("ask_questions", QUESTIONS)] });
    expect(await interviewOf(s)).toMatchObject({ status: "waiting", statusReason: "questions" });
    expect(requestsOf("asker")).toHaveLength(3);
    setRetryDelays([5_000, 15_000, 30_000]);
  });

  // Seen: a plan that failed left its project "working" in the sidebar for good.
  it("says a plan that failed for good has stalled", async () => {
    setRetryDelays([10, 10, 10]);
    const broken = { fail: { status: 400, message: "Bad request" } };
    const s = await setup({ asker: [broken] });
    expect(await interviewOf(s)).toMatchObject({ status: "failed" });
    expect(await workOf(s.project.id)).toMatchObject({ status: "planning", planStalled: true });
    setRetryDelays([5_000, 15_000, 30_000]);
  });

  // Seen live: a plan model answered with nothing through a reseller, and "no plan" did not say why.
  it("says a model that answers with nothing answered with nothing", async () => {
    const s = await setup({ asker: [noQuestions], planner: [{ text: "" }, { text: "" }] });
    await env.call("POST", `/api/projects/${s.project.id}/work/plan`, { task: "Сайт", models: { interview: s.ref("asker"), plan: s.ref("planner"), work: s.ref("asker"), strong: null } });
    const work = await until(s.project.id, (w) => !!w.planTaskId);
    let task: any;
    for (let i = 0; i < 300; i++) {
      task = await (await env.call("GET", `/api/tasks/${work.planTaskId}`)).json();
      if (task.status === "failed") break;
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(task).toMatchObject({ status: "failed", statusReason: "empty_answer" });
  });

  // Seen live: the plan was thin even from a strong model; the user wants the pages, the technology and the look in it.
  it("keeps the plan's pages with what is on them and the technical decisions with their reasons", async () => {
    const full = {
      ...PLAN,
      screens: [{ name: "Каталог", contents: "Врачи по специальностям, свободное время, кнопка «Заказ»" }],
      decisions: [{ what: "Vite + React", why: "быстрый старт и простая сборка" }],
    };
    const s = await setup({ coder: [noQuestions, call("write_plan", full)] });
    const work = await planned(s);
    expect(work.plan).toMatchObject({ screens: full.screens, decisions: full.decisions });
    expect(JSON.stringify(requestsOf("coder")[1]!.body.messages[0])).toMatch(/screens.*decisions/s);
  });

  it("rewrites the plan with the user's corrections", async () => {
    const s = await setup({ coder: [noQuestions, writePlan, call("write_plan", { ...PLAN, steps: ["Каталог", "Доставка"] })] });
    await planned(s);
    expect((await env.call("POST", `/api/projects/${s.project.id}/work/revise`, { note: "Добавь доставку" })).status).toBe(200);
    const work = await until(s.project.id, (w) => w.status === "ready" && w.plan.steps.includes("Доставка"));
    expect(work.checklist.map((i: any) => i.text)).toEqual(["Каталог", "Доставка"]);
    expect(JSON.stringify(requestsOf("coder").at(-1)!.body.messages)).toContain("Добавь доставку");
  });

  it("goes on \"Go\": the project's conversation in its folder, the agent's checklist, files, and done with finish_work", async () => {
    const s = await setup({
      coder: [
        noQuestions,
        writePlan,
        call("write_file", { path: "catalog.html", content: "<ul></ul>\n" }),
        call("update_checklist", { items: [{ text: "Каталог", done: true }, { text: "Калькулятор", done: true }, { text: "Проверить страницы", done: true }] }),
        call("finish_work", { report: "Сделал каталог и калькулятор. Запуск: npm run dev." }),
        { text: "Готово: каталог и калькулятор." },
      ],
    });
    await planned(s);
    const res = await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    expect(res.status).toBe(200);
    const { chatId } = await res.json();
    const work = await until(s.project.id, (w) => w.status === "done");
    expect(work.checklist.every((i: any) => i.done)).toBe(true);
    expect(work.actions).toBeGreaterThanOrEqual(3);
    expect(readFileSync(join(folder, "catalog.html"), "utf8")).toBe("<ul></ul>\n");
    const chat = await (await env.call("GET", `/api/chats/${chatId}`)).json();
    expect(chat).toMatchObject({ projectId: s.project.id, itemId: null, folder });
    expect(chat.messages[0]).toMatchObject({ role: "user" });
    expect(chat.messages[0].content).toContain("Каталог");
    expect(chat.messages.at(-1)).toMatchObject({ role: "assistant", status: "done" });
    // The report is the answer's own text: it stays when the user writes on (seen: a card at the end vanished).
    expect(chat.messages.at(-1).content).toContain("Сделал каталог и калькулятор. Запуск: npm run dev.");
    // The work is committed in the branch the project is on, no branch of the agent's own (asked for).
    expect(git(folder, "branch", "--show-current")).toBe("main");
    expect(git(folder, "log", "--oneline", "main").split("\n").length).toBeGreaterThan(1);
    expect(git(folder, "status", "--porcelain")).toBe("");
    // The plan's task is over once the work started.
    expect((await (await env.call("GET", `/api/tasks/${work.planTaskId}`)).json()).statusReason).toBe("started");
  });

  // Seen: four MCP servers were switched on and the project's run had none of them (only the interview did).
  it("gives the run the tools of the user's MCP servers", async () => {
    const server = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
    await env.call("POST", "/api/mcp", { name: "demo", command: process.execPath, args: [server], trust: "trusted" });
    const s = await setup({
      coder: [
        noQuestions,
        writePlan,
        call("mcp_demo_echo", { text: "кедр" }),
        call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) }),
        call("finish_work", { report: "Готово." }),
        { text: "Готово." },
      ],
    });
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "done");
    const sent = requestsOf("coder").at(-1)!.body;
    expect(sent.tools.map((t: any) => t.function.name)).toContain("mcp_demo_echo");
    expect(JSON.stringify(sent.messages)).toContain("echo: кедр");
  });

  it("takes a message the user writes while it works into the next answer, and goes on", async () => {
    const s = await setup({
      coder: [
        noQuestions,
        writePlan,
        { ...call("list_files", { path: "." }), delayMs: 600 },
        call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) }),
        call("finish_work", { report: "Готово, кнопка зелёная." }),
      ],
    });
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "running");
    const sent = await (await env.call("POST", `/api/projects/${s.project.id}/work/message`, { content: "Сделай кнопку зелёной" })).json();
    expect(sent.queued).toBe(true);
    await until(s.project.id, (w) => w.status === "done");
    const later = requestsOf("coder").slice(3);
    expect(later.some((r) => JSON.stringify(r.body.messages).includes("Сделай кнопку зелёной"))).toBe(true);
    const chat = await (await env.call("GET", `/api/chats/${sent.chatId}`)).json();
    expect(chat.messages.filter((m: any) => m.role === "user").map((m: any) => m.content)).toContain("Сделай кнопку зелёной");
  });

  // Seen live: "0 min, 0 ₽" for minutes in the panel, as time and money were counted only when an answer of many steps ended.
  it("counts the time and the money of the answer going on now", async () => {
    const s = await setup(
      {
        coder: [
          noQuestions,
          writePlan,
          { ...call("list_files", { path: "." }), usage: { prompt_tokens: 100_000, completion_tokens: 1000 } },
          { ...call("list_files", { path: "." }), delayMs: 1500 },
          call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) }),
          call("finish_work", { report: "Готово." }),
        ],
      },
      PRICED,
    );
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 5, hours: 2 });
    const during = await until(s.project.id, (w) => w.status === "running" && w.spentUsd > 0);
    expect(during.workedMs).toBeGreaterThan(0);
    expect(during.spentUsd).toBeCloseTo(0.102, 3);
    const done = await until(s.project.id, (w) => w.status === "done");
    // The code review before the end costs a little too.
    expect(done.spentUsd).toBeGreaterThanOrEqual(during.spentUsd);
    expect(done.spentUsd).toBeLessThan(during.spentUsd + 0.01);
  });

  it("asks without waiting: the question is kept and the work goes on", async () => {
    const s = await setup({
      coder: [
        noQuestions,
        writePlan,
        call("ask_user", { question: "Нужна доставка?", assumption: "Пока без доставки" }),
        call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) }),
        call("finish_work", { report: "Готово." }),
      ],
    });
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    const work = await until(s.project.id, (w) => w.status === "done");
    expect(work.questions).toEqual([expect.objectContaining({ question: "Нужна доставка?", assumption: "Пока без доставки" })]);
  });

  it("stops when the budget runs out, and goes on once it is raised", async () => {
    const big = { prompt_tokens: 1_000_000, completion_tokens: 0 };
    const s = await setup(
      {
        coder: [
          noQuestions,
          writePlan,
          { ...call("list_files", { path: "." }), usage: big },
          call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) }),
          call("finish_work", { report: "Готово." }),
        ],
      },
      PRICED,
    );
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 0.5, hours: 2 });
    const paused = await until(s.project.id, (w) => w.status === "paused");
    expect(paused).toMatchObject({ reason: "budget" });
    expect(paused.spentUsd).toBeGreaterThanOrEqual(0.5);
    await env.call("PATCH", `/api/projects/${s.project.id}/work`, { budgetUsd: 5 });
    expect((await env.call("POST", `/api/projects/${s.project.id}/work/continue`)).status).toBe(200);
    expect(await until(s.project.id, (w) => w.status === "done")).toMatchObject({ budgetUsd: 5 });
  });

  it("reminds a model that stops without finish_work, then hands the work to the strong model", async () => {
    const s = await setup({
      coder: [noQuestions, writePlan, { text: "Сделал." }, { text: "Всё." }, { text: "Готово." }, { text: "Точно готово." }],
      strong: [call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) }), call("finish_work", { report: "Доделал." })],
    });
    await planned(s, { strong: "strong" });
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    const work = await until(s.project.id, (w) => w.status === "done" || w.status === "paused");
    expect(work).toMatchObject({ status: "done", escalated: true });
    expect(JSON.stringify(requestsOf("coder").at(-1)!.body.messages)).toMatch(/Open checklist items: Каталог; Калькулятор; Проверить страницы/);
    expect(requestsOf("strong").length).toBeGreaterThan(0);
  });

  it("waits as stuck when there is no strong model", async () => {
    const s = await setup({ coder: [noQuestions, writePlan, { text: "1" }, { text: "2" }, { text: "3" }, { text: "4" }] });
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    expect(await until(s.project.id, (w) => w.status === "paused")).toMatchObject({ reason: "stuck" });
  });

  it("refuses to plan in a folder without git", async () => {
    const plain = mkdtempSync(join(tmpdir(), "drimvox-plain-"));
    const s = await setup({});
    const project = await (await env.call("POST", "/api/projects", { path: plain })).json();
    const res = await env.call("POST", `/api/projects/${project.id}/work/plan`, {
      task: "Сайт",
      models: { interview: s.ref("coder"), plan: s.ref("coder"), work: s.ref("coder"), strong: null },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "not_repo" } });
    rmSync(plain, { recursive: true, force: true });
  });

  // Seen live: after "Go" the agent wrote in English until the user asked in Russian.
  it("tells the working model to write in the user's language", async () => {
    const s = await setup({ coder: [noQuestions, writePlan, call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) }), call("finish_work", { report: "Готово." })] });
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "done");
    expect(JSON.stringify(requestsOf("coder").at(-1)!.body.messages[0])).toMatch(/language the user writes in/);
  });

  // Seen live: the checklist stayed unticked for an hour and a half until the user asked why.
  it("reminds the agent to tick the checklist after many actions without it", async () => {
    const busy = Array.from({ length: 26 }, () => call("list_files", { path: "." }));
    const s = await setup({ coder: [noQuestions, writePlan, ...busy, call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) }), call("finish_work", { report: "Готово." })] });
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "done");
    expect(requestsOf("coder").some((r) => JSON.stringify(r.body.messages).includes("Tick off in the checklist"))).toBe(true);
  });

  // Seen live: the report came before the end and the work trailed off in thoughts; the user wants the result started.
  // The workspace's "Changes": what the agent did to the folder since the last commit, new files too, index untouched.
  it("shows the folder's changes since the last commit", async () => {
    const s = await setup({ coder: [noQuestions] });
    writeFileSync(join(folder, "index.html"), "<h1>Клиника «Здоровье»</h1>\n");
    mkdirSync(join(folder, "src"));
    writeFileSync(join(folder, "src", "app.js"), "export const a = 1;\n");
    const files = (await (await env.call("GET", `/api/projects/${s.project.id}/work/changes`)).json()) as { path: string; status: string; added: number }[];
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["index.html", "modified"],
      ["src/app.js", "added"],
    ]);
    expect(git(folder, "diff", "--cached", "--name-only")).toBe("");
  });

  it("keeps the report apart and starts the finished project, until it is stopped", async () => {
    const port = 41000 + Math.floor(Math.random() * 2000);
    writeFileSync(join(folder, "server.js"), `require("http").createServer((q, r) => r.end("ok")).listen(${port});\n`);
    const s = await setup({
      coder: [
        noQuestions,
        writePlan,
        call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) }),
        call("finish_work", { report: "Сделал сайт. Запуск: node server.js.", start: { command: "node server.js", url: `http://localhost:${port}/` } }),
      ],
    });
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    const done = await until(s.project.id, (w) => w.status === "done" && w.site?.running);
    expect(done).toMatchObject({ report: "Сделал сайт. Запуск: node server.js.", site: { url: `http://localhost:${port}/`, running: true } });
    // The report after the work: the actions it took and the checklist.
    const report = await (await env.call("GET", `/api/projects/${s.project.id}/work/report`)).json();
    expect(report).toMatchObject({ checklist: { done: PLAN.steps.length, total: PLAN.steps.length } });
    expect(report.actions.map((a: { name: string }) => a.name)).toEqual(expect.arrayContaining(["update_checklist", "finish_work"]));
    // The process runs at once; the server listens a moment later.
    let answer = "";
    for (let i = 0; i < 50 && answer !== "ok"; i++) {
      answer = await fetch(`http://localhost:${port}/`).then((r) => r.text(), () => "");
      if (answer !== "ok") await new Promise((r) => setTimeout(r, 100));
    }
    expect(answer).toBe("ok");
    expect((await env.call("POST", `/api/projects/${s.project.id}/work/site/stop`)).status).toBe(200);
    expect((await workOf(s.project.id)).site).toMatchObject({ running: false });
    expect((await env.call("POST", `/api/projects/${s.project.id}/work/site/start`)).status).toBe(200);
    await until(s.project.id, (w) => w.site?.running);
    await env.call("POST", `/api/projects/${s.project.id}/work/site/stop`);
    // The folder is free once the process is gone.
    for (let i = 0; i < 50 && (await fetch(`http://localhost:${port}/`).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
  });

  // Asked for: the agent judged its pages only by "is it there", never by how they look.
  it("has the result's look reviewed once before it is done: the pages on a desktop and a phone, notes for one round of polish", async () => {
    const port = 43000 + Math.floor(Math.random() * 2000);
    writeFileSync(join(folder, "server.js"), `require("http").createServer((q, r) => r.end("<h1>ok</h1>")).listen(${port});\n`);
    const shots: { url: string; width: number }[] = [];
    env.setScreenshot(async (url, size) => {
      shots.push({ url, width: size.width });
      return Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    });
    const url = `http://localhost:${port}/`;
    const brief = { direction: "Тихая бухгалтерия", concept: "Спокойный светлый кабинет", palette: [{ role: "фон", hex: "#F6F7F4" }, { role: "текст", hex: "#111827" }, { role: "акцент", hex: "#157F5B" }], fonts: { heading: { name: "Golos Text", kind: "sans-serif" }, body: { name: "Inter", kind: "sans-serif" } }, rules: ["Иконки — линейные SVG"] };
    const done = call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) });
    const finishing = call("finish_work", { report: "Готово.", start: { command: "node server.js", url } });
    const reviews: string[] = [];
    fake = await startFakeProvider({
      key: KEY,
      models: [
        { id: "coder", supported_parameters: ["tools"] },
        { id: "eyes", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      ],
      respond: (body) => {
        if (body.model === "eyes") {
          reviews.push(JSON.stringify(body.messages));
          return { text: "POLISH\n- Иконки категорий — эмодзи: заменить на линейные SVG\n- На телефоне суммы налезают на названия: перенести суммы на новую строку" };
        }
        if (isReviewer(body)) return call("report_review", { issues: [], summary: "Проблем нет." });
        return queue.shift() ?? { text: "Готово." };
      },
    });
    const queue: FakeTurn[] = [noQuestions, call("write_plan", { ...PLAN, pages: [{ url, command: "node server.js" }], design: brief }), done, finishing, call("write_file", { path: "index.html", content: "<h1>ok</h1>\n" }), finishing];
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    await env.call("PATCH", "/api/settings", { visionModel: { providerId: provider.id, model: "eyes" } });
    const project = await (await env.call("POST", "/api/projects", { path: folder })).json();
    const ref = { providerId: provider.id, model: "coder" };
    await env.call("POST", `/api/projects/${project.id}/work/plan`, { task: "Сайт", models: { interview: ref, plan: ref, work: ref, strong: null } });
    await until(project.id, (w) => w.status === "ready");
    await env.call("POST", `/api/projects/${project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    const w = await until(project.id, (x) => x.status === "done");

    // One review, against the plan's brief, of the page on a desktop and a phone.
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain("Тихая бухгалтерия");
    // The report counts the agent's actions, not the screenshots' marks or Drimvox's own review (seen: "Calls screenshot").
    const report = await (await env.call("GET", `/api/projects/${project.id}/work/report`)).json();
    expect(report.actions.map((a: { name: string }) => a.name)).not.toEqual(expect.arrayContaining(["screenshot"]));
    expect(report.actions.map((a: { name: string }) => a.name)).not.toEqual(expect.arrayContaining(["design_review"]));
    expect(shots).toEqual(expect.arrayContaining([{ url, width: 1280 }, { url, width: 390 }]));
    // The first finish_work brought the notes, not the end; the second one ended the work.
    const coder = requestsOf("coder").map((r) => JSON.stringify(r.body.messages));
    expect(coder.some((m) => m.includes("Иконки категорий — эмодзи"))).toBe(true);
    expect(w.report).toBe("Готово.");
    await env.call("POST", `/api/projects/${project.id}/work/site/stop`);
    for (let i = 0; i < 50 && (await fetch(url).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
    // The folder is free once both processes (the review's and the started site) are gone: Windows lets go of it late.
    await new Promise((r) => setTimeout(r, 1500));
  });

  it("offers the project's skills in the run, and the agent can open one", async () => {
    mkdirSync(join(folder, ".drimvox", "skills", "style"), { recursive: true });
    writeFileSync(join(folder, ".drimvox", "skills", "style", "SKILL.md"), ["---", "name: style", "description: When making pages for this site", "---", "Use the brand green.", ""].join("\n"));
    const s = await setup({
      coder: [noQuestions, writePlan, call("use_skill", { name: "style" }), call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) }), call("finish_work", { report: "Готово." })],
    });
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "done");
    const run = requestsOf("coder").slice(2);
    expect(JSON.stringify(run[0]!.body.messages[0])).toContain("style: When making pages for this site");
    expect(JSON.stringify(run[1]!.body.messages)).toContain("Use the brand green.");
  });

  // Seen live: three skills were switched on and only one was ever opened, at the very start.
  it("names the skills not opened yet before the work is done, once", async () => {
    mkdirSync(join(folder, ".drimvox", "skills", "verify"), { recursive: true });
    writeFileSync(join(folder, ".drimvox", "skills", "verify", "SKILL.md"), ["---", "name: verify", "description: Use when about to claim work is complete", "---", "Run the checks first.", ""].join("\n"));
    const done = call("finish_work", { report: "Готово." });
    const s = await setup({
      coder: [noQuestions, writePlan, call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) }), done, call("use_skill", { name: "verify" }), done],
    });
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "done");
    const sent = JSON.stringify(requestsOf("coder").at(-1)!.body.messages);
    expect(sent).toContain("Before you finish: these skills are ready and you have not opened them.");
    expect(sent).toContain("verify: Use when about to claim work is complete");
    expect(sent).toContain("Run the checks first.");
  });

  // Seen live: a team board let anyone listen to any board over WebSocket; the coder's own tests never looked there.
  it("has the code reviewed once before it is done, by the working model, with the user's security skills", async () => {
    mkdirSync(join(folder, ".drimvox", "skills", "owasp"), { recursive: true });
    writeFileSync(join(folder, ".drimvox", "skills", "owasp", "SKILL.md"), ["---", "name: owasp", "description: Security review checklist", "---", "Check every real-time channel.", ""].join("\n"));
    const done = call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) });
    const finishing = call("finish_work", { report: "Готово." });
    // A server: there is something to attack (a static page alone gets no review, below).
    writeFileSync(join(folder, "server.js"), "const http = require('http');\n");
    const issue = { severity: "high", where: "src/ws.ts", problem: "Anyone can subscribe to any board", fix: "Check team membership on connect" };
    const s = await setup({
      // Finishing: first the skill not opened yet, then the review's problems, then done.
      coder: [noQuestions, writePlan, done, finishing, call("use_skill", { name: "owasp" }), finishing, call("write_file", { path: "ws.js", content: "// checked\n" }), finishing],
      reviewer: [call("report_review", { issues: [issue, { ...issue, severity: "low", problem: "Naming" }], summary: "One hole." })],
    });
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "done");
    const reviews = fake!.requests.filter((r) => r.path === "/v1/chat/completions" && isReviewer(r.body));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.body.model).toBe("coder");
    expect(JSON.stringify(reviews[0]!.body.messages[0])).toContain("Check every real-time channel.");
    const sent = JSON.stringify(requestsOf("coder").at(-1)!.body.messages);
    expect(sent).toContain("A code reviewer read the project");
    expect(sent).toContain("Anyone can subscribe to any board");
    // Low ones are not worth a round of fixes.
    expect(sent).not.toContain("Naming");
    // The sending back is in the conversation for the user to see (seen live: "the review asks for…" out of nowhere).
    const work = await (await env.call("GET", `/api/projects/${s.project.id}/work`)).json();
    const chat = await (await env.call("GET", `/api/chats/${work.chatId}`)).json();
    const activity = chat.messages.flatMap((m: any) => m.activity);
    expect(activity).toContainEqual(expect.objectContaining({ name: "sent_back", input: "code:1" }));
    expect(activity).toContainEqual(expect.objectContaining({ name: "sent_back", input: "skills:1" }));
  });

  // Asked for: a plain HTML page was reviewed for security; it has no server, no accounts and no one's data.
  it("gives a static page no security review", async () => {
    const done = call("update_checklist", { items: PLAN.steps.map((text) => ({ text, done: true })) });
    const s = await setup({ coder: [noQuestions, writePlan, call("write_file", { path: "app.js", content: "document.title = 'Погода';\n" }), done, call("finish_work", { report: "Готово." })] });
    await planned(s);
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "done");
    expect(fake!.requests.filter((r) => r.path === "/v1/chat/completions" && isReviewer(r.body))).toHaveLength(0);
  });

  it("is done by Claude Code itself in the project's folder when the working model is on a subscription", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drimvox-fake-cli-"));
    process.env.FAKE_CLI_DIR = dir;
    writeFileSync(join(dir, "script.json"), JSON.stringify([{ text: "Сделал калькулятор.", files: { "calculator.html": "<form></form>\n" } }]));
    env.setCliCommand("claude-code", [process.execPath, fileURLToPath(new URL("./fake-cli.mjs", import.meta.url)), "claude"]);
    const s = await setup({ coder: [noQuestions, writePlan] });
    const cli = await (await env.call("POST", "/api/providers", { preset: "claude-code" })).json();
    await env.call("POST", `/api/projects/${s.project.id}/work/plan`, {
      task: "Сайт клиники",
      models: { interview: s.ref("coder"), plan: s.ref("coder"), work: { providerId: cli.id, model: "default" }, strong: null },
    });
    await until(s.project.id, (w) => w.status === "ready");
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "done");
    expect(readFileSync(join(folder, "calculator.html"), "utf8")).toBe("<form></form>\n");
    rmSync(dir, { recursive: true, force: true });
  });
});

// Asked for: a ready project works like the chat with a folder (no interview, no plan to approve), and the agent keeps
// its own plan for the sidebar.
describe("a ready project", () => {
  it("guesses a ready project by the files in its folder", async () => {
    expect(await (await env.call("POST", "/api/projects/peek", { path: folder })).json()).toEqual({ files: 1, guess: "existing" });
    const empty = mkdtempSync(join(tmpdir(), "drimvox-empty-"));
    mkdirSync(join(empty, ".git"));
    expect(await (await env.call("POST", "/api/projects/peek", { path: empty })).json()).toEqual({ files: 0, guess: "new" });
    rmSync(empty, { recursive: true, force: true });
  });

  it("is added as ready and can be told apart later", async () => {
    const created = await (await env.call("POST", "/api/projects", { path: folder, kind: "existing" })).json();
    expect(created.kind).toBe("existing");
    const changed = await (await env.call("PATCH", `/api/projects/${created.id}`, { kind: "new" })).json();
    expect(changed.kind).toBe("new");
    const other = mkdtempSync(join(tmpdir(), "drimvox-new-"));
    const fresh = await (await env.call("POST", "/api/projects", { path: other })).json();
    expect(fresh.kind).toBe("new");
    rmSync(other, { recursive: true, force: true });
  });

  // Asked for: fewer tokens at the same quality. On "auto", the first step thinks as the provider decides, the routine
  // ones after it think little, and a step after a failed tool thinks fully again.
  it("thinks fully on the first step and after a failure, little on the routine steps between", async () => {
    const s = await setup({
      coder: [call("list_files", { path: "." }), call("read_file", { path: "no-such-file.txt" }), call("list_files", { path: "." }), { text: "Готово." }],
    });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Посмотри проект", model: s.ref("coder") });
    await until(s.project.id, (w) => w.status === "done");
    const efforts = requestsOf("coder").map((r) => r.body.reasoning?.effort ?? null);
    expect(efforts[0]).toBeNull();
    expect(efforts[1]).toBe("low");
    expect(efforts.length).toBeGreaterThanOrEqual(4);
  });

  // Seen live: "the site looked fine at 20 rubles", and the agent polished on, answer after answer. Asked for: no pause,
  // as Claude Code; at each 60 steps the agent is asked whether what was asked is done.
  it("goes on past 60 steps without a pause, asking the agent to stop if the task is done", async () => {
    const s = await setup({ coder: [...Array.from({ length: 62 }, () => call("list_files", { path: "." })), { text: "Готово: сайт сделан." }] });
    const res = await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Сделай сайт", model: s.ref("coder") });
    expect(res.status).toBe(200);
    const work = await until(s.project.id, (w) => w.status === "done");
    expect(work.reason).toBeNull();
    expect(JSON.stringify(requestsOf("coder").at(-1)!.body.messages)).toContain("60 steps on this message");
  });

  it("answers the first message at once, keeps its plan, ends without finish_work and goes on with the next message", async () => {
    const s = await setup({
      coder: [
        call("update_checklist", { items: [{ text: "Найти ошибку", done: true }, { text: "Поправить", done: false }] }),
        { text: "Нашёл и поправил: сумма считается заново." },
        { text: "Это главная страница." },
      ],
    });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    const res = await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Почини сумму", model: s.ref("coder") });
    expect(res.status).toBe(200);
    let work = await until(s.project.id, (w) => w.status === "done");
    expect(work.plan).toBeNull();
    expect(work.checklist).toEqual([{ text: "Найти ошибку", done: true }, { text: "Поправить", done: false }]);
    // No reminders to finish: it answered and stopped, as in a chat.
    expect(requestsOf("coder")).toHaveLength(2);
    expect(JSON.stringify(requestsOf("coder")[0]!.body.messages[0])).toContain("existing project");
    const chat = await (await env.call("GET", `/api/chats/${work.chatId}`)).json();
    expect(chat.messages.map((m: any) => m.content)).toEqual(["Почини сумму", "Нашёл и поправил: сумма считается заново."]);

    // Written to once, the project's kind stays (asked for).
    expect((await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "new" })).status).toBe(409);
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "А это что?", model: s.ref("coder") });
    work = await until(s.project.id, (w) => w.status === "done" && requestsOf("coder").length === 3);
    const again = await (await env.call("GET", `/api/chats/${work.chatId}`)).json();
    expect(again.messages.at(-1).content).toBe("Это главная страница.");
  });

  // Seen live: the agent started the same server three times, as each answer's end stopped it.
  it("keeps a server the agent started running between the user's messages, and asks for no endless polishing", async () => {
    const s = await setup({
      coder: [
        call("start_background", { command: 'node -e "setInterval(() => {}, 1000)"' }),
        { text: "Сервер запущен." },
        call("read_background", { id: 1 }),
        call("stop_background", { id: 1 }),
        { text: "Всё ещё работал, остановил." },
      ],
    });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Запусти сайт", model: s.ref("coder") });
    await until(s.project.id, (w) => w.status === "done");
    expect(JSON.stringify(requestsOf("coder")[0]!.body.messages[0])).toContain("no endless polishing");
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Он работает?", model: s.ref("coder") });
    await until(s.project.id, (w) => w.status === "done" && requestsOf("coder").length === 5);
    expect(JSON.stringify(requestsOf("coder")[3]!.body.messages)).toContain("Process 1 (running)");
    // The process lets go of the folder before it is removed.
    await new Promise((r) => setTimeout(r, 1500));
  });

  // Seen in a manual test: GLM was cut by its output limit three times in a row (its long thinking counts too), and the
  // run said "done" with nothing written. After a cut it thinks less; cut every time, the run stops and says why.
  it("thinks less after a cut, and stops saying why when every answer is cut", async () => {
    const cut = { text: "Пишу весь сайт…", finishReason: "length" };
    const s = await setup({ coder: Array.from({ length: 8 }, () => cut) });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Сделай сайт погоды", model: s.ref("coder") });
    const work = await until(s.project.id, (w) => w.status !== "running" && w.status !== "idle");
    expect(work).toMatchObject({ status: "paused", reason: "error" });
    expect(work.detail).toMatch(/cut by its output limit 4 times in a row/);
    expect(JSON.stringify(requestsOf("coder")[0]!.body)).not.toContain('"effort":"low"');
    expect(JSON.stringify(requestsOf("coder")[1]!.body)).toContain('"effort":"low"');
    expect(JSON.stringify(requestsOf("coder")[1]!.body.messages)).toMatch(/at most about 200 lines/);
  }, 60_000);

  // Seen live (1.8.4): GLM's output limit cut a step in the middle of its tool calls; the calls went back to the model
  // without results, the provider refused every request after ("Tool results are missing"), and nothing more was done.
  it("goes on after an answer cut in the middle of its tool calls, and the next message works too", async () => {
    const s = await setup({
      coder: [
        { toolCalls: [{ name: "write_file", args: { path: "index.html", content: "<h1>Погода</h1>\n" } }, { name: "write_file", args: { path: "app.js", content: "" } }], finishReason: "length" },
        call("write_file", { path: "index.html", content: "<h1>Погода</h1>\n" }),
        { text: "Сайт готов." },
        { text: "Всё работает." },
      ],
    });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Сделай сайт погоды", model: s.ref("coder") });
    const work = await until(s.project.id, (w) => w.status !== "running" && requestsOf("coder").length >= 3);
    expect(work).toMatchObject({ status: "done", reason: null });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Проверь", model: s.ref("coder") });
    expect(await until(s.project.id, (w) => w.status !== "running" && requestsOf("coder").length >= 4)).toMatchObject({ status: "done", reason: null });
    // No tool call goes to the model without its result.
    for (const r of requestsOf("coder")) {
      const msgs = r.body.messages as any[];
      const answered = new Set(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
      for (const m of msgs) for (const c of m.tool_calls ?? []) expect(answered.has(c.id)).toBe(true);
    }
  });

  // Said in a video on agents: a request late in a long conversation costs several times one at its start; one task, one
  // conversation.
  it("starts again with a clean context: a new conversation, the old one kept, the project's notes still there", async () => {
    const s = await setup({ coder: [call("update_notes", { notes: "Сайт клиники, запуск: npm run dev" }), { text: "Первая задача готова." }, { text: "Вторая готова." }] });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Первая задача", model: s.ref("coder") });
    const first = await until(s.project.id, (w) => w.status === "done");
    const res = await env.call("POST", `/api/projects/${s.project.id}/work/fresh`);
    expect(res.status).toBe(200);
    expect(await workOf(s.project.id)).toMatchObject({ chatId: null, startedAt: null, checklist: [], tokens: { input: 0, output: 0, context: null } });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Вторая задача", model: s.ref("coder") });
    const second = await until(s.project.id, (w) => w.status === "done" && w.chatId !== null);
    expect(second.chatId).not.toBe(first.chatId);
    const sent = JSON.stringify(requestsOf("coder").at(-1)!.body.messages);
    // Not the old conversation; the project's notes and state (its last goal among them) go on.
    expect(sent).not.toContain("Первая задача готова.");
    expect(sent).toContain("Сайт клиники, запуск: npm run dev");
    expect((await env.call("GET", `/api/chats/${first.chatId}`)).status).toBe(200);
  });

  // Said in a video on agents: take the raw output of the tests, not the model's word that all is fixed.
  it("runs the project's tests itself before the work is done: a failure goes back to the agent, a pass into the report", async () => {
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "node check.js" } }));
    writeFileSync(join(folder, "check.js"), "console.error('FAIL: сумма неверна'); process.exit(1);\n");
    git(folder, "add", "-A");
    git(folder, "commit", "-q", "-m", "Tests");
    const s = await setup({
      coder: [
        call("finish_work", { report: "Всё починил, тесты проходят." }),
        call("write_file", { path: "check.js", content: "console.log('ok: 3 tests');\n" }),
        call("finish_work", { report: "Починил сумму." }),
      ],
    });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Почини сумму", model: s.ref("coder") });
    const work = await until(s.project.id, (w) => w.status === "done");
    expect(JSON.stringify(requestsOf("coder")[1]!.body.messages)).toContain("FAIL: сумма неверна");
    expect(work.report).toContain("Починил сумму.");
    expect(work.report).toMatch(/npm test.*прошли/);
    expect(work.report).toContain("ok: 3 tests");
  });

  // Asked for: changed files shown in the conversation where the agent changed them, with the lines added and removed.
  it("keeps with each write and edit the lines it added and removed", async () => {
    const s = await setup({
      coder: [
        call("write_file", { path: "index.html", content: "<h1>Клиника</h1>\n<p>Запись</p>\n<p>Цены</p>\n" }),
        call("edit_file", { edits: [{ path: "index.html", old: "<p>Цены</p>", new: "<p>Прайс</p>\n<p>Врачи</p>" }] }),
        { text: "Готово." },
      ],
    });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Поправь страницу", model: s.ref("coder") });
    const work = await until(s.project.id, (w) => w.status === "done");
    const chat = await (await env.call("GET", `/api/chats/${work.chatId}`)).json();
    const acts = chat.messages.at(-1).activity.map(({ at: _at, ...a }: any) => a);
    // The folder had "<h1>Клиника</h1>": the write kept it and added two lines; the edit changed one and added one.
    expect(acts).toEqual([
      { name: "write_file", input: "index.html", added: 2, removed: 0 },
      { name: "edit_file", input: "index.html", added: 2, removed: 1 },
    ]);
  });

  // Asked for: the thinking level in the projects' mode (the model always thought at its fullest), and the strong model
  // picked under the box, as the interview's and the plan's.
  it("takes the thinking level and the strong model with the message, and keeps them for the run's next answers", async () => {
    const s = await setup({ coder: [{ text: "Готово." }, { text: "И это готово." }] });
    const res = await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Сделай", model: s.ref("coder"), thinking: "low", strong: s.ref("coder") });
    expect(res.status).toBe(200);
    const work = await until(s.project.id, (w) => w.status === "done");
    expect(work.models.strong).toEqual(s.ref("coder"));
    expect(JSON.stringify(requestsOf("coder")[0]!.body)).toContain('"effort":"low"');
    await env.call("POST", `/api/projects/${s.project.id}/work/message`, { content: "Ещё", thinking: "high" });
    await until(s.project.id, (w) => w.status === "done" && requestsOf("coder").length >= 2);
    expect(JSON.stringify(requestsOf("coder")[1]!.body)).toContain('"effort":"high"');
  });

  // Asked for: what runs in the background is shown and can be stopped. Seen live: two servers on one port, as the agent
  // started its server again not knowing it still ran.
  it("lists the processes running in the background, stops one, and does not start the same command twice", async () => {
    const server = 'node -e "setInterval(() => {}, 1000)"';
    const s = await setup({
      coder: [
        call("start_background", { command: server }),
        call("start_background", { command: server }),
        call("start_background", { command: 'node -e "setTimeout(() => {}, 100)"' }),
        { text: "Сервер запущен." },
      ],
    });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Запусти сайт", model: s.ref("coder") });
    await until(s.project.id, (w) => w.status === "done");
    expect(JSON.stringify(requestsOf("coder")[2]!.body.messages)).toMatch(/already running as process 1/);
    // Another command of the same agent hears what still runs from before.
    expect(JSON.stringify(requestsOf("coder")[3]!.body.messages)).toMatch(/Also running from before: process 1/);
    const listed = (await (await env.call("GET", "/api/processes")).json()) as any[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 1, command: server, owner: { kind: "project", projectId: s.project.id } });
    expect(listed[0].owner.name).toBeTruthy();
    expect((await env.call("POST", "/api/processes/stop", { key: listed[0].key, id: 1 })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await (await env.call("GET", "/api/processes")).json()).toEqual([]);
  });

  // As Codex's tool_search: rarely needed tools are not sent with every step; the model loads them when it needs them.
  it("sends the rare tools only after the model asks for them", async () => {
    const s = await setup({
      coder: [call("find_tools", { names: ["email_new", "load_test"] }), call("email_new", {}), { text: "Готово." }],
    });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Заведи почту", model: s.ref("coder") });
    await until(s.project.id, (w) => w.status === "done");
    const names = (n: number) => (requestsOf("coder")[n]!.body.tools ?? []).map((t: any) => t.function.name) as string[];
    expect(names(0)).toContain("edit_file");
    expect(names(0)).toContain("find_tools");
    expect(names(0)).not.toContain("email_new");
    const find = (requestsOf("coder")[0]!.body.tools as any[]).find((t) => t.function.name === "find_tools");
    expect(find.function.description).toContain("email_new");
    expect(names(1)).toContain("email_new");
    expect(names(1)).toContain("load_test");
    expect(names(1).length).toBeLessThan(names(0).length + 3);
  });

  // As Aider's repo map: a ready project's files and what each defines start the agent's instructions.
  it("gives the agent of a ready project its map of files", async () => {
    for (let n = 1; n <= 16; n++) writeFileSync(join(folder, `part${n}.js`), `export function part${n}() {}
`);
    git(folder, "add", "-A");
    git(folder, "commit", "-q", "-m", "Parts");
    const s = await setup({ coder: [{ text: "Готово." }] });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Что тут есть?", model: s.ref("coder") });
    await until(s.project.id, (w) => w.status === "done");
    expect(JSON.stringify(requestsOf("coder")[0]!.body.messages[0])).toContain("part7.js (1 lines): part7");
  });

  // Asked for: how full the model's context is, as in a chat, and what the tokens went to.
  it("tells the tokens the model read and wrote, and how much of its context the latest step took", async () => {
    const s = await setup({
      coder: [
        { ...call("list_files", { path: "." }), usage: { prompt_tokens: 1000, completion_tokens: 50 } },
        // Asked for: what came from the provider's cache, the cheap part of what is read again.
        { ...call("list_files", { path: "." }), delayMs: 1500, usage: { prompt_tokens: 3000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 900 } } },
        { text: "Готово.", usage: { prompt_tokens: 5000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 2900 } } },
      ],
    });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Посмотри файлы", model: s.ref("coder") });
    const during = await until(s.project.id, (w) => w.status === "running" && w.tokens.context === 1000);
    expect(during.tokens).toMatchObject({ input: 1000, output: 50, cached: 0 });
    const done = await until(s.project.id, (w) => w.status === "done");
    expect(done.tokens).toEqual({ input: 9000, output: 170, cached: 3800, context: 5000 });
  });

  // Seen live: "Now I write the styles…", then the provider's output limit cut the answer, and the run counted it as done.
  it("goes on when the provider cuts an answer by its length, and asks for big files in parts", async () => {
    const s = await setup({
      coder: [
        { text: "Теперь пишу стили…", finishReason: "length" },
        call("write_file", { path: "styles.css", content: "body {}\n" }),
        { text: "Стили готовы." },
      ],
    });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Сделай стили", model: s.ref("coder") });
    await until(s.project.id, (w) => w.status === "done");
    expect(readFileSync(join(folder, "styles.css"), "utf8")).toBe("body {}\n");
    expect(requestsOf("coder")).toHaveLength(3);
    expect(JSON.stringify(requestsOf("coder")[1]!.body.messages)).toContain("cut off by the output limit");
  });
});

// Asked for: the agent works with git by the project's rules — a branch, commits on its word, accept or reject.
describe("a project's git rules", () => {
  async function ready(turns: FakeTurn[], rules: Record<string, unknown> = {}) {
    const s = await setup({ coder: turns });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    const put = await env.call("PUT", `/api/projects/${s.project.id}/git/rules`, { target: "task-branch", commit: "per-item", messages: "en", push: false, pullRequest: false, allowMain: false, ...rules });
    expect(put.status).toBe(200);
    return s;
  }
  const ask = async (s: Awaited<ReturnType<typeof ready>>, content: string, turns: number) => {
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content, model: s.ref("coder") });
    return until(s.project.id, (w) => w.status === "done" && requestsOf("coder").length >= turns);
  };

  it("commits in the project's branch when the agent says, leaves secrets out, and tells the agent how to write", async () => {
    const s = await ready([
      call("write_file", { path: "cart.js", content: "total()\n" }),
      call("write_file", { path: ".env", content: "KEY=secret\n" }),
      call("commit_changes", { message: "Fix cart total" }),
      { text: "Готово." },
    ]);
    await ask(s, "Почини корзину", 4);
    expect(git(folder, "branch", "--show-current")).toBe("main");
    // The agent's own commit, then Drimvox's with the project's state for whoever picks it up next.
    expect(git(folder, "log", "--format=%s", "-2").split("\n")).toEqual(["Почини корзину", "Fix cart total"]);
    expect(git(folder, "show", "--name-only", "--format=", "HEAD~1").split("\n")).toEqual(["cart.js"]);
    // AGENTS.md only: pointer files for other agents only when the settings ask (asked for: not every agent is Claude).
    expect(git(folder, "show", "--name-only", "--format=", "HEAD").split("\n")).toEqual(["AGENTS.md"]);
    const agents = readFileSync(join(folder, "AGENTS.md"), "utf8");
    expect(agents).toContain("## Project state (kept by Drimvox)");
    expect(agents).toContain("Goal: Почини корзину");
    expect(agents).toContain("Git branch: main");
    expect(existsSync(join(folder, "CLAUDE.md"))).toBe(false);
    expect(git(folder, "status", "--porcelain")).toBe("?? .env");
    const system = JSON.stringify(requestsOf("coder")[0]!.body.messages[0]);
    expect(system).toContain("commit_changes");
    expect(system).toContain("in English");
    const view = await (await env.call("GET", `/api/projects/${s.project.id}/git`)).json();
    expect(view.state).toMatchObject({ branch: "main", base: null, github: false, pullRequest: null });
  });

  it("makes pointer files for the agents chosen in the settings", async () => {
    const s = await ready([{ text: "Готово." }]);
    await env.call("PATCH", "/api/settings", { agentFiles: ["gemini", "qwen", "copilot", "windsurf"] });
    await ask(s, "Сделай что-нибудь", 1);
    expect(readFileSync(join(folder, "GEMINI.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(readFileSync(join(folder, "QWEN.md"), "utf8")).toBe("@AGENTS.md\n");
    // Agents without "@file" get the pointer in words, in their own folders (asked for: more agents than three).
    expect(readFileSync(join(folder, ".github", "copilot-instructions.md"), "utf8")).toMatch(/^Read AGENTS\.md/);
    expect(readFileSync(join(folder, ".windsurf", "rules", "drimvox.md"), "utf8")).toMatch(/^Read AGENTS\.md/);
    expect(existsSync(join(folder, "CLAUDE.md"))).toBe(false);
  });

  // Seen live: a project left on "drimvox/task-1106-2048 → master" from before, which said nothing to its user.
  it("brings an agent's branch left from before back into the branch it came from, and works there", async () => {
    const s = await ready([call("write_file", { path: "b.txt", content: "b\n" }), { text: "Готово." }]);
    git(folder, "switch", "-q", "-c", "drimvox/task-1106-2048");
    writeFileSync(join(folder, "a.txt"), "a\n");
    git(folder, "add", "a.txt");
    git(folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a");
    env.db.sql
      .prepare("insert into settings (key, value) values (?, ?)")
      .run(`git.branch:${s.project.id}`, JSON.stringify({ branch: "drimvox/task-1106-2048", base: "main", pullRequest: null }));
    await ask(s, "Сделай b", 2);
    expect(git(folder, "branch", "--show-current")).toBe("main");
    expect(git(folder, "ls-files")).toContain("a.txt");
    expect(git(folder, "ls-files")).toContain("b.txt");
  });

  // Asked for: a project's answer is undone like a chat's — the folder back as it was before it.
  it("undoes an answer of the agent: the files back as they were before it", async () => {
    const s = await ready([call("write_file", { path: "index.html", content: "<h1>Сломано</h1>\n" }), call("write_file", { path: "new.js", content: "x\n" }), { text: "Готово." }], { commit: "never" });
    const work = await ask(s, "Поменяй заголовок", 3);
    const chat = await (await env.call("GET", `/api/chats/${work.chatId}`)).json();
    const answer = chat.messages.find((m: any) => m.role === "assistant" && m.canUndo);
    expect(answer).toBeTruthy();
    expect((await env.call("POST", `/api/chats/${work.chatId}/messages/${answer.id}/undo`)).status).toBe(200);
    expect(readFileSync(join(folder, "index.html"), "utf8")).toBe("<h1>Клиника</h1>\n");
    expect(existsSync(join(folder, "new.js"))).toBe(false);
  });

  it("commits nothing when the rules say so, and the agent is told git is the user's", async () => {
    const s = await ready([call("write_file", { path: "a.txt", content: "a\n" }), { text: "Готово." }], { commit: "never" });
    await ask(s, "Сделай a", 2);
    expect(git(folder, "branch", "--show-current")).toBe("main");
    expect(git(folder, "log", "--oneline").split("\n")).toHaveLength(1);
    expect(JSON.stringify(requestsOf("coder")[0]!.body.tools ?? []).includes("commit_changes")).toBe(false);
    expect(JSON.stringify(requestsOf("coder")[0]!.body.messages[0])).toContain("Never commit or push");
  });
});

// Seen live: three project folders renamed on the desktop, and every project asked to turn git on again.
describe("a project whose folder was renamed or moved", () => {
  it("finds the folder by the marks its conversation left in git, and moves the project and its conversation there", async () => {
    const s = await setup({ coder: [call("write_file", { path: "rates.js", content: "1\n" }), { text: "Готово." }] });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Сделай курсы", model: s.ref("coder") });
    const work = await until(s.project.id, (w) => w.status === "done");
    const moved = `${folder}-переименована`;
    renameSync(folder, moved);
    folder = moved;
    const list = (await (await env.call("GET", "/api/projects")).json()) as any[];
    expect(list.find((p) => p.id === s.project.id)).toMatchObject({ path: moved, gitState: "ready" });
    const chat = await (await env.call("GET", `/api/chats/${work.chatId}`)).json();
    expect(chat.folder).toBe(moved);
  });

  it("says a folder it cannot find is missing, and takes its new place from the user", async () => {
    const s = await setup({});
    const other = makeRepo({ "index.html": "<h1>Клиника</h1>\n" });
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    folder = other;
    const list = (await (await env.call("GET", "/api/projects")).json()) as any[];
    expect(list.find((p) => p.id === s.project.id)).toMatchObject({ gitState: "missing" });
    expect((await env.call("POST", `/api/projects/${s.project.id}/move`, { path: join(other, "nope") })).status).toBe(400);
    const res = await env.call("POST", `/api/projects/${s.project.id}/move`, { path: other });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: other, gitState: "ready" });
  });
});

// Asked for: one branch per project with a readable name, not drimvox/task-1106-2010.
describe("the project's branch name", () => {
  it("is the project's name in any script, words joined by dashes", () => {
    expect(slug("Сайт погоды")).toBe("сайт-погоды");
    expect(slug("тест 2")).toBe("тест-2");
    expect(slug("My CRM: v2!")).toBe("my-crm-v2");
    expect(slug("***")).toBe("");
  });
});
