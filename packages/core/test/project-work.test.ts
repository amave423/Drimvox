import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { git, makeRepo } from "./git-repo";

// docs/specs/project-work.md: an interview, a plan, "Go", then one long run of the agent with its own checklist.
vi.setConfig({ testTimeout: 30_000 });

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider | undefined;
let folder: string;

beforeEach(() => {
  env = createTestEnv();
  folder = makeRepo({ "index.html": "<h1>Лесопилка</h1>\n" });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });
const noQuestions = call("ask_questions", { questions: [], understood: "Сайт лесопилки", unknown: [] });
const PLAN = {
  summary: "Сайт лесопилки: каталог досок и калькулятор заказа.",
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
    respond: (body) => queues[body.model]?.shift() ?? { text: "Готово." },
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
    task: "Сайт лесопилки",
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

const requestsOf = (model: string) => fake!.requests.filter((r) => r.path === "/v1/chat/completions" && r.body.model === model);

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
    // Nothing to accept: the work is in the folder, git stays the user's.
    expect(git(folder, "log", "--oneline").split("\n")).toHaveLength(1);
    // The plan's task is over once the work started.
    expect((await (await env.call("GET", `/api/tasks/${work.planTaskId}`)).json()).statusReason).toBe("started");
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

  it("is done by Claude Code itself in the project's folder when the working model is on a subscription", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drimvox-fake-cli-"));
    process.env.FAKE_CLI_DIR = dir;
    writeFileSync(join(dir, "script.json"), JSON.stringify([{ text: "Сделал калькулятор.", files: { "calculator.html": "<form></form>\n" } }]));
    env.setCliCommand("claude-code", [process.execPath, fileURLToPath(new URL("./fake-cli.mjs", import.meta.url)), "claude"]);
    const s = await setup({ coder: [noQuestions, writePlan] });
    const cli = await (await env.call("POST", "/api/providers", { preset: "claude-code" })).json();
    await env.call("POST", `/api/projects/${s.project.id}/work/plan`, {
      task: "Сайт лесопилки",
      models: { interview: s.ref("coder"), plan: s.ref("coder"), work: { providerId: cli.id, model: "default" }, strong: null },
    });
    await until(s.project.id, (w) => w.status === "ready");
    await env.call("POST", `/api/projects/${s.project.id}/work/start`, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "done");
    expect(readFileSync(join(folder, "calculator.html"), "utf8")).toBe("<form></form>\n");
    rmSync(dir, { recursive: true, force: true });
  });
});
