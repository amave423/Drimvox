import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { makeRepo } from "./git-repo";

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider | undefined;
let repo: string;

const MATH = "export function add(a, b) {\n  return a + b;\n}\n";
const MATH_BOTH = MATH + "export function subtract(a, b) {\n  return a - b;\n}\n";
const TEST_BOTH =
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add, subtract } from "./math.js";\n\n' +
  'test("add", () => assert.equal(add(2, 3), 5));\ntest("subtract", () => assert.equal(subtract(5, 3), 2));\n';

beforeEach(() => {
  env = createTestEnv();
  repo = makeRepo({ "package.json": '{ "type": "module" }\n', "math.js": MATH, "math.test.js": 'import "./math.js";\n' });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });
const finish = (summary: string) => ({ name: "finish", args: { summary, commit_message: "Add subtract" } });
const spec = call("propose_spec", {
  spec: "# Вычитание и документация",
  checks: ["node --test"],
  plan: ["Функция", "README"],
  stages: [{ title: "Функция subtract" }, { title: "Документация" }],
  requirements: [
    { id: "R1", text: "subtract(a, b) возвращает разность", verify: "check", how: "node --test", stage: 1 },
    { id: "R2", text: "README описывает subtract", verify: "review", how: "README.md", stage: 2 },
  ],
});
const stage1: FakeTurn = {
  toolCalls: [
    { name: "write_file", args: { path: "math.js", content: MATH_BOTH } },
    { name: "write_file", args: { path: "math.test.js", content: TEST_BOTH } },
    finish("Этап 1"),
  ],
};
const stage2: FakeTurn = { toolCalls: [{ name: "write_file", args: { path: "README.md", content: "# subtract\n" } }, finish("Этап 2")] };
const verdict = (ids: string[]) =>
  call("report_acceptance", { results: ids.map((id) => ({ id, status: "done", evidence: "ok", problem: "" })), summary: `Принято: ${ids.join(", ")}` });

const isAcceptor = (body: any) => /acceptance agent/i.test(JSON.stringify(body.messages?.[0]?.content ?? ""));

async function start(coder: FakeTurn[], acceptor: FakeTurn[], stops: boolean) {
  const coderQueue = [...coder];
  const acceptorQueue = [...acceptor];
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "coder" }],
    respond: (body) => (isAcceptor(body) ? acceptorQueue.shift() : coderQueue.shift()) ?? { text: "Done." },
  });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
  const res = await env.call("POST", `/api/projects/${project.id}/tasks`, {
    task: "Добавь subtract и документацию",
    providerId: provider.id,
    model: "coder",
    stages: { interview: false, spec: true, approveSpec: stops, testsFirst: false },
  });
  const id = (await res.json()).id as string;
  if (stops) {
    const proposed = await waitFor(id, (t) => t.statusReason === "spec_review");
    await env.call("POST", `/api/tasks/${id}/spec`, { spec: proposed.spec, checks: proposed.checks });
  }
  return id;
}

async function waitFor(id: string, check: (task: any) => boolean, timeoutMs = 20_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const task = await (await env.call("GET", `/api/tasks/${id}`)).json();
    if (check(task)) return task;
    if (Date.now() > until) throw new Error(`stuck: ${task.status}/${task.statusReason}/${task.phase}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}
const settled = (t: any) => !["running", "queued"].includes(t.status);
const events = async (id: string) => (await (await env.call("GET", `/api/tasks/${id}/events`)).json()) as any[];
const acceptorBriefs = () =>
  fake!.requests.filter((r) => r.path === "/v1/chat/completions" && isAcceptor(r.body) && r.body.messages.length === 2).map((r) => JSON.stringify(r.body.messages[1]));
const lastCoderMessage = () => JSON.stringify(fake!.requests.filter((r) => r.path === "/v1/chat/completions" && !isAcceptor(r.body)).at(-1)!.body.messages);

describe("a big task in stages", () => {
  it("does and accepts one stage after another on its own", async () => {
    const id = await start([spec, stage1, stage2], [verdict(["R1"]), verdict(["R1", "R2"])], false);
    const done = await waitFor(id, settled);
    expect(done).toMatchObject({ status: "review", statusReason: null, milestone: 2 });
    expect(done.milestones).toEqual([{ title: "Функция subtract" }, { title: "Документация" }]);
    expect(done.requirements.map((r: any) => [r.id, r.stage])).toEqual([
      ["R1", 1],
      ["R2", 2],
    ]);

    // Stage 1 is accepted on its own requirements; stage 2 on everything so far.
    const [first, second] = acceptorBriefs();
    expect(first).toContain("R1");
    expect(first).not.toContain("R2");
    expect(second).toContain("R2");
    // Seen live: stage 1 was sent back for detail pages that stage 2 makes.
    expect(first).toMatch(/not expected yet[\s\S]*Документация[\s\S]*README описывает subtract/);
    expect(second).not.toMatch(/not expected yet/);
    expect((await events(id)).filter((e) => e.kind === "milestone").map((e) => e.data.stage)).toEqual([1]);
    expect(lastCoderMessage()).toContain("stage 2");
  });

  // Seen live: the spec's pages described the whole site; stage 1 failed on the sky map of stage 2 and burned the budget.
  it("looks at each stage's pages only, not at what later stages will add", async () => {
    const shots: string[] = [];
    env.setScreenshot(async (url) => {
      shots.push(url);
      return Buffer.from("89504e470d0a1a0a", "hex");
    });
    const coder = [
      call("propose_spec", {
        spec: "# Сайт",
        checks: ["node --test"],
        plan: ["Главная", "Карта"],
        stages: [{ title: "Главная" }, { title: "Карта неба" }],
        requirements: [
          { id: "R1", text: "Главная", verify: "visual", how: "главная", stage: 1 },
          { id: "R2", text: "Карта", verify: "visual", how: "карта", stage: 2 },
        ],
        visual_checks: [
          { url: "http://localhost:5173/", expect: "Главная с заголовком", stage: 1 },
          { url: "http://localhost:5173/#map", expect: "Карта неба с созвездиями", stage: 2 },
        ],
      }),
      stage1,
      stage2,
    ];
    const acceptor = [verdict(["R1"]), verdict(["R1", "R2"])];
    fake = await startFakeProvider({
      key: KEY,
      models: [{ id: "coder" }, { id: "eyes", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } }],
      respond: (body) => {
        if (body.model === "eyes") return { text: "PASS: всё на месте" };
        return (isAcceptor(body) ? acceptor.shift() : coder.shift()) ?? { text: "Done." };
      },
    });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    await env.call("PATCH", "/api/settings", { visionModel: { providerId: provider.id, model: "eyes" } });
    const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
    const res = await env.call("POST", `/api/projects/${project.id}/tasks`, {
      task: "Сделай сайт",
      providerId: provider.id,
      model: "coder",
      stages: { interview: false, spec: true, approveSpec: false, testsFirst: false },
    });
    const id = (await res.json()).id as string;
    expect(await waitFor(id, settled)).toMatchObject({ status: "review" });
    expect((await (await env.call("GET", `/api/tasks/${id}`)).json()).visualChecks.map((v: any) => v.stage)).toEqual([1, 2]);

    // Stage 1 looked at its own page; stage 2 at both.
    const feed = await events(id);
    const milestone = feed.findIndex((e) => e.kind === "milestone");
    const looked = (from: number, to: number) => feed.slice(from, to).filter((e) => e.kind === "check" && e.data.phase === "visual").map((e) => e.data.command.split(" — ")[0]);
    expect(looked(0, milestone)).toEqual(["http://localhost:5173/"]);
    expect(looked(milestone, feed.length)).toEqual(["http://localhost:5173/", "http://localhost:5173/#map"]);
  });

  it("waits after each stage when the task runs with stops", async () => {
    const id = await start([spec, stage1, stage2], [verdict(["R1"]), verdict(["R1", "R2"])], true);
    const between = await waitFor(id, settled);
    expect(between).toMatchObject({ status: "waiting", statusReason: "milestone_review", milestone: 2 });
    expect((await env.call("POST", `/api/tasks/${id}/continue`, {})).status).toBe(200);
    expect(await waitFor(id, settled)).toMatchObject({ status: "review", statusReason: null });
  });

  it("goes to review with what is done when the user says enough between stages", async () => {
    const id = await start([spec, stage1, stage2], [verdict(["R1"])], true);
    await waitFor(id, (t) => t.statusReason === "milestone_review");
    expect((await env.call("POST", `/api/tasks/${id}/finish-early`, {})).status).toBe(200);
    const done = await waitFor(id, settled);
    expect(done).toMatchObject({ status: "review", statusReason: "milestones_left" });
    const diff = await (await env.call("GET", `/api/tasks/${id}/diff`)).json();
    expect(diff.map((f: any) => f.path).sort()).toEqual(["math.js", "math.test.js"]);
  });
});
