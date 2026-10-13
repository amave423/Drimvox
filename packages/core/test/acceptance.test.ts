import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { makeRepo } from "./git-repo";

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider | undefined;
let repo: string;

const MATH = "export function add(a, b) {\n  return a + b;\n}\n";
const TEST_BOTH =
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add, subtract } from "./math.js";\n\n' +
  'test("add", () => assert.equal(add(2, 3), 5));\ntest("subtract", () => assert.equal(subtract(5, 3), 2));\n';
const MATH_BOTH = MATH + "export function subtract(a, b) {\n  return a - b;\n}\n";

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
const REQUIREMENTS = [
  { id: "R1", text: "subtract(a, b) возвращает a - b", verify: "check", how: "node --test" },
  { id: "R2", text: "README.md описывает subtract", verify: "review", how: "прочитать README.md" },
];
const spec = call("propose_spec", {
  spec: "# Вычитание\n\nДобавить subtract.",
  checks: ["node --test"],
  plan: ["Функция", "README"],
  requirements: REQUIREMENTS,
  decisions: ["Без зависимостей"],
});
const code = (readme: string): FakeTurn => ({
  toolCalls: [
    { name: "write_file", args: { path: "math.js", content: MATH_BOTH } },
    { name: "write_file", args: { path: "math.test.js", content: TEST_BOTH } },
    { name: "write_file", args: { path: "README.md", content: readme } },
    { name: "finish", args: { summary: "Готово", commit_message: "Add subtract" } },
  ],
});
const verdict = (r2: "done" | "missing"): FakeTurn =>
  call("report_acceptance", {
    results: [
      { id: "R1", status: "done", evidence: "node --test: 2 pass", problem: "" },
      { id: "R2", status: r2, evidence: "README.md", problem: r2 === "done" ? "" : "README не упоминает subtract" },
    ],
    summary: r2 === "done" ? "Всё сделано" : "Не хватает README",
  });

/** The coder and the acceptance agent answer from their own scripts: the acceptance agent is told it accepts work. */
async function start(coder: FakeTurn[], acceptor: FakeTurn[], acceptanceModel?: string) {
  const coderQueue = [...coder];
  const acceptorQueue = [...acceptor];
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "coder" }, { id: "judge" }],
    respond: (body) =>
      (/acceptance agent/i.test(JSON.stringify(body.messages?.[0]?.content ?? "")) ? acceptorQueue.shift() : coderQueue.shift()) ?? { text: "Done." },
  });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  if (acceptanceModel) await env.call("PATCH", "/api/settings", { acceptanceModel: { providerId: provider.id, model: acceptanceModel } });
  const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
  const res = await env.call("POST", `/api/projects/${project.id}/tasks`, {
    task: "Добавь subtract(a, b) и опиши её в README",
    providerId: provider.id,
    model: "coder",
    stages: { interview: false, spec: true, approveSpec: false, testsFirst: false },
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
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
const settled = (t: any) => t.status !== "running" && t.status !== "queued";
const events = async (id: string) => (await (await env.call("GET", `/api/tasks/${id}/events`)).json()) as any[];
const acceptorRequests = () => fake!.requests.filter((r) => r.path === "/v1/chat/completions" && /acceptance agent/i.test(JSON.stringify(r.body.messages[0]?.content ?? "")));
const coderRequests = () => fake!.requests.filter((r) => r.path === "/v1/chat/completions" && !acceptorRequests().includes(r));

describe("requirements", () => {
  it("keeps the spec's numbered requirements and the agent's own decisions", async () => {
    const id = await start([spec, code("# Math\n\nsubtract(a, b)\n")], [verdict("done")]);
    const task = await waitFor(id, settled);
    expect(task.requirements).toEqual(REQUIREMENTS);
    expect(task.decisions).toEqual(["Без зависимостей"]);
    expect(JSON.stringify(coderRequests().at(-1)!.body.messages)).toContain("R2. README.md описывает subtract");
  });
});

describe("acceptance", () => {
  it("accepts work when every requirement is done", async () => {
    const id = await start([spec, code("# Math\n\nsubtract(a, b)\n")], [call("read_file", { path: "README.md" }), verdict("done")]);
    const task = await waitFor(id, settled);
    expect(task).toMatchObject({ status: "review", statusReason: null });
    expect(task.acceptance).toMatchObject({ round: 1, summary: "Всё сделано", model: "coder" });
    expect(task.acceptance.results.map((r: any) => [r.id, r.status])).toEqual([
      ["R1", "done"],
      ["R2", "done"],
    ]);

    // The acceptance agent reads and runs, but cannot edit.
    const tools = acceptorRequests()[0]!.body.tools.map((t: any) => t.function.name);
    expect(tools).toEqual(expect.arrayContaining(["read_file", "run_command", "report_acceptance"]));
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("edit_file");
    expect(JSON.stringify(acceptorRequests()[0]!.body.messages)).toContain("README.md описывает subtract");

    const feed = await events(id);
    expect(feed.filter((e) => e.kind === "acceptance").map((e) => e.data.round)).toEqual([1]);
    expect(feed.some((e) => e.kind === "tool_call" && e.data.name === "read_file")).toBe(true);
  });

  it("sends unmet requirements back to the coder and accepts the rework", async () => {
    const id = await start([spec, code("# Math\n"), code("# Math\n\nsubtract(a, b) вычитает.\n")], [verdict("missing"), verdict("done")]);
    const task = await waitFor(id, settled);
    expect(task).toMatchObject({ status: "review", statusReason: null });
    expect(task.acceptance.round).toBe(2);
    const told = JSON.stringify(coderRequests().at(-1)!.body.messages);
    expect(told).toContain("R2");
    expect(told).toContain("README не упоминает subtract");
  });

  it("hands the work over with an honest report after three rounds", async () => {
    const id = await start(
      [spec, code("# Math\n"), code("# Math\n"), code("# Math\n")],
      [verdict("missing"), verdict("missing"), verdict("missing"), verdict("done")],
    );
    const task = await waitFor(id, settled);
    expect(task).toMatchObject({ status: "review", statusReason: "acceptance_partial" });
    expect(task.acceptance.round).toBe(3);
    expect(acceptorRequests().filter((r) => r.body.messages.length === 2)).toHaveLength(3);
  });

  it("uses the acceptance model from the settings", async () => {
    await start([spec, code("# Math\n\nsubtract\n")], [verdict("done")], "judge");
    await waitFor((await (await env.call("GET", "/api/tasks")).json())[0].id, settled);
    expect(new Set(acceptorRequests().map((r) => r.body.model))).toEqual(new Set(["judge"]));
  });

  it("drops whatever the acceptance agent left in the copy", async () => {
    const id = await start(
      [spec, code("# Math\n\nsubtract\n")],
      [call("run_command", { command: `node -e "require('fs').writeFileSync('scratch.txt', 'x')"` }), verdict("done")],
    );
    await waitFor(id, settled);
    const diff = await (await env.call("GET", `/api/tasks/${id}/diff`)).json();
    expect(diff.map((f: any) => f.path).sort()).toEqual(["README.md", "math.js", "math.test.js"]);
    expect(() => readFileSync(join(repo, "scratch.txt"))).toThrow();
  });
});
