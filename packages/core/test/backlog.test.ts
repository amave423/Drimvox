import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { makeRepo } from "./git-repo";

vi.setConfig({ testTimeout: 30_000 });

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider | undefined;
let repo: string;

beforeEach(() => {
  env = createTestEnv();
  repo = makeRepo({ "README.md": "# Timer\n" });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });
const finish = call("finish", { summary: "Готово", commit_message: "Add the timer" });
const TASKS = [
  { title: "MVP: таймер 25 минут", done: ["Кнопка «Старт» запускает отсчёт 25:00", "Отсчёт виден на странице"], size: "M" },
  { title: "Пауза и сброс", done: ["Кнопки паузы и сброса работают"], size: "S" },
  { title: "Статистика за неделю", done: ["График помидоров по дням"], size: "L" },
];
const list = call("propose_tasks", {
  context: "Сайт-таймер помодоро для себя: тёмный, простой.",
  tasks: TASKS,
  checks: ["node -e \"process.exit(0)\""],
  pages: [{ url: "http://localhost:5173/", command: "npx serve ." }],
});
const verdict = (ids: string[]) =>
  call("report_acceptance", { results: ids.map((id) => ({ id, status: "done", evidence: "видно", problem: "" })), summary: "Принято" });
const isAcceptor = (body: any) => /acceptance agent/i.test(JSON.stringify(body.messages?.[0]?.content ?? ""));

async function setup(coder: FakeTurn[], acceptor: FakeTurn[] = []) {
  const coderQueue = [...coder];
  const acceptorQueue = [...acceptor];
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "coder" }],
    respond: (body) => (isAcceptor(body) ? acceptorQueue.shift() : coderQueue.shift()) ?? { text: "Done." },
  });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
  return { providerId: provider.id as string, projectId: project.id as string };
}

async function settle(id: string) {
  for (let i = 0; i < 600; i++) {
    const task = await (await env.call("GET", `/api/tasks/${id}`)).json();
    if (!["running", "queued"].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("stuck");
}
const backlog = async (projectId: string) => (await (await env.call("GET", `/api/projects/${projectId}/backlog`)).json()) as { items: any[]; plan: any };

describe("the task list", () => {
  it("ends the interview with the list of tasks, the MVP first, and keeps what they share", async () => {
    const { providerId, projectId } = await setup([call("ask_questions", { questions: [] }), list]);
    const res = await env.call("POST", `/api/projects/${projectId}/backlog/plan`, { task: "Сделай помодоро-таймер", providerId, model: "coder" });
    expect(res.status).toBe(201);
    const plan = await settle((await res.json()).id);
    expect(plan).toMatchObject({ status: "done_empty", statusReason: "listed", kind: "plan" });
    const { items, plan: shared } = await backlog(projectId);
    expect(items.map((i) => [i.title, i.size, i.status])).toEqual([
      ["MVP: таймер 25 минут", "M", "open"],
      ["Пауза и сброс", "S", "open"],
      ["Статистика за неделю", "L", "open"],
    ]);
    expect(shared).toMatchObject({ context: "Сайт-таймер помодоро для себя: тёмный, простой.", pages: [{ url: "http://localhost:5173/" }] });
  });

  it("refuses a batch heavier than three points", async () => {
    const { providerId, projectId } = await setup([call("ask_questions", { questions: [] }), list]);
    await settle((await (await env.call("POST", `/api/projects/${projectId}/backlog/plan`, { task: "Помодоро", providerId, model: "coder" })).json()).id);
    const { items } = await backlog(projectId);
    const res = await env.call("POST", `/api/projects/${projectId}/backlog/run`, { ids: [items[0].id, items[2].id], providerId, model: "coder" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "too_many_points" } });
  });

  it("does the batch one task at a time: reviewed, accepted into the folder, then the next on the user's word", async () => {
    const write = call("write_file", { path: "index.html", content: "<button>Старт</button><p>25:00</p>\n" });
    const pause = call("write_file", { path: "pause.js", content: "export const pause = () => {};\n" });
    const { providerId, projectId } = await setup([call("ask_questions", { questions: [] }), list, write, finish, pause, finish], [verdict(["R1", "R2"]), verdict(["R1"])]);
    await settle((await (await env.call("POST", `/api/projects/${projectId}/backlog/plan`, { task: "Помодоро", providerId, model: "coder" })).json()).id);
    const { items } = await backlog(projectId);

    const started = await env.call("POST", `/api/projects/${projectId}/backlog/run`, { ids: [items[0].id, items[1].id], providerId, model: "coder" });
    expect(started.status).toBe(201);
    const first = await settle((await started.json()).id);
    expect(first).toMatchObject({ status: "review", kind: "item" });
    expect(first.task).toContain("Кнопка «Старт» запускает отсчёт 25:00");
    expect((await backlog(projectId)).items.map((i) => i.status)).toEqual(["active", "picked", "open"]);

    expect((await env.call("POST", `/api/tasks/${first.id}/accept`, {})).status).toBe(200);
    expect(readFileSync(join(repo, "index.html"), "utf8")).toContain("Старт");
    expect((await backlog(projectId)).items.map((i) => i.status)).toEqual(["done", "picked", "open"]);
    // Nothing starts before the user says so.
    expect(existsSync(join(repo, "pause.js"))).toBe(false);

    const next = await env.call("POST", `/api/projects/${projectId}/backlog/next`);
    expect(next.status).toBe(201);
    const second = await settle((await next.json()).id);
    expect(second.task).toContain("Кнопки паузы и сброса работают");
    await env.call("POST", `/api/tasks/${second.id}/discard`);
    expect((await backlog(projectId)).items.map((i) => i.status)).toEqual(["done", "open", "open"]);
    expect((await env.call("POST", `/api/projects/${projectId}/backlog/next`)).status).toBe(409);
  });
});
