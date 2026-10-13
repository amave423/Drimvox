import { existsSync, rmSync } from "node:fs";
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
const TEST_ADD = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./math.js";\n\ntest("add", () => assert.equal(add(2, 3), 5));\n';
const TEST_BOTH = TEST_ADD.replace('import { add } from "./math.js";', 'import { add, subtract } from "./math.js";') + 'test("subtract", () => assert.equal(subtract(5, 3), 2));\n';
const MATH_BOTH = MATH + "export function subtract(a, b) {\n  return a - b;\n}\n";

beforeEach(() => {
  env = createTestEnv();
  repo = makeRepo({ "package.json": '{ "type": "module" }\n', "math.js": MATH, "math.test.js": TEST_ADD });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });
const finish = (summary = "Готово") => call("finish", { summary, commit_message: "Add subtract" });
const spec = (checks = ["node --test"]) =>
  call("propose_spec", { spec: "# Вычитание\n\nДобавить subtract(a, b).", checks, plan: ["Тест на subtract", "Функция subtract"] });

interface Steps {
  interview?: boolean;
  spec?: boolean;
  approveSpec?: boolean;
  testsFirst?: boolean;
}

async function start(script: FakeTurn[], steps: Steps = {}, extraModels: Record<string, unknown>[] = []) {
  fake = await startFakeProvider({ key: KEY, script, models: [{ id: "coder" }, ...extraModels] });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
  const res = await env.call("POST", `/api/projects/${project.id}/tasks`, {
    task: "Добавь subtract(a, b) с тестом",
    providerId: provider.id,
    model: "coder",
    stages: { interview: true, spec: true, approveSpec: true, testsFirst: true, ...steps },
  });
  expect(res.status).toBe(201);
  return { id: (await res.json()).id as string, providerId: provider.id as string };
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
const waiting = (reason: string) => (t: any) => t.status === "waiting" && t.statusReason === reason;
const status = (s: string) => (t: any) => t.status === s;
const events = async (id: string) => (await (await env.call("GET", `/api/tasks/${id}/events`)).json()) as any[];
const chatRequests = () => fake!.requests.filter((r) => r.path === "/v1/chat/completions");

describe("the full path", () => {
  it("interviews, writes a spec, goes red with tests, then green with code, then review", async () => {
    const { id } = await start([
      call("ask_questions", {
        questions: [
          { id: "name", question: "Как назвать функцию?", options: [{ label: "subtract", description: "Как в задаче" }, { label: "minus" }], recommended: 0 },
        ],
      }),
      spec(),
      call("write_file", { path: "math.test.js", content: TEST_BOTH }),
      finish("Тест на subtract написан"),
      call("write_file", { path: "math.js", content: MATH_BOTH }),
      finish("subtract готова"),
    ]);

    const asked = await waitFor(id, waiting("questions"));
    expect(asked.questions).toEqual([
      { id: "name", question: "Как назвать функцию?", options: [{ label: "subtract", description: "Как в задаче" }, { label: "minus", description: "" }], recommended: 0 },
    ]);
    expect(asked.phase).toBe("interview");

    expect((await env.call("POST", `/api/tasks/${id}/answers`, { answers: [{ id: "name", answer: "subtract" }] })).status).toBe(200);
    const proposed = await waitFor(id, waiting("spec_review"));
    expect(proposed).toMatchObject({ phase: "spec", checks: ["node --test"], plan: ["Тест на subtract", "Функция subtract"] });
    expect(proposed.spec).toContain("# Вычитание");
    expect(JSON.stringify(chatRequests().at(-1)!.body.messages)).toContain("subtract");

    const approved = await env.call("POST", `/api/tasks/${id}/spec`, { spec: "# Вычитание\n\nПравка владельца.", checks: ["node --test"] });
    expect(approved.status).toBe(200);
    const done = await waitFor(id, status("review"));
    expect(done.summary).toBe("subtract готова");

    const checks = (await events(id)).filter((e) => e.kind === "check").map((e) => [e.data.phase, e.data.command, e.data.ok]);
    expect(checks).toEqual([
      ["tests", "node --test", false],
      ["code", "node --test", true],
    ]);
    const phases = (await events(id)).filter((e) => e.kind === "phase").map((e) => e.data.phase);
    expect(phases).toEqual(["interview", "spec", "tests", "code"]);
    expect(JSON.stringify(chatRequests().at(-1)!.body.messages)).toContain("Правка владельца");
  });

  // Seen live: a spec the model ended with a newline came back trimmed, and the agent was told the user had edited it.
  it("does not call a spec edited when the user approved it as it was", async () => {
    const { id } = await start([call("propose_spec", { spec: "# Вычитание\n\nДобавить subtract.\n\n", checks: ["node --test"], plan: [] }), finish()], {
      interview: false,
      testsFirst: false,
    });
    const proposed = await waitFor(id, waiting("spec_review"));
    await env.call("POST", `/api/tasks/${id}/spec`, { spec: proposed.spec, checks: proposed.checks });
    await waitFor(id, (t) => t.phase === "code" && t.status !== "running");
    const told = JSON.stringify(chatRequests().at(-1)!.body.messages);
    expect(told).toContain("The spec is approved:");
    expect(told).not.toContain("with their edits");
  });

  it("does not let the agent edit files while interviewing or writing the spec", async () => {
    const { id } = await start([call("write_file", { path: "hack.txt", content: "x" }), call("ask_questions", { questions: [] }), spec()]);
    await waitFor(id, waiting("spec_review"));
    const result = (await events(id)).find((e) => e.kind === "tool_result");
    expect(result.data).toMatchObject({ ok: false });
    expect(existsSync(join(repo, "hack.txt"))).toBe(false);
  });

  it("goes straight to the spec when the agent has no questions", async () => {
    const { id } = await start([call("ask_questions", { questions: [] }), spec()]);
    await waitFor(id, waiting("spec_review"));
  });

  it("skips the interview and the approval when asked", async () => {
    const { id } = await start(
      [spec(), call("write_file", { path: "math.test.js", content: TEST_BOTH }), finish(), call("write_file", { path: "math.js", content: MATH_BOTH }), finish()],
      { interview: false, approveSpec: false },
    );
    const done = await waitFor(id, status("review"));
    expect(done.spec).toContain("# Вычитание");
  });

  it("lets the user skip the interview", async () => {
    const { id } = await start([call("ask_questions", { questions: [{ id: "a", question: "?", options: [{ label: "x" }, { label: "y" }] }] }), spec()]);
    await waitFor(id, waiting("questions"));
    await env.call("POST", `/api/tasks/${id}/answers`, { skip: true });
    await waitFor(id, waiting("spec_review"));
  });

  it("rewrites the spec on request", async () => {
    const { id } = await start([spec(), call("propose_spec", { spec: "# Вторая версия", checks: ["node --test"], plan: [] })], { interview: false });
    await waitFor(id, waiting("spec_review"));
    await env.call("POST", `/api/tasks/${id}/spec/revise`, { note: "Добавь раздел про ошибки" });
    const revised = await waitFor(id, (t) => t.status === "waiting" && t.spec === "# Вторая версия");
    expect(revised.statusReason).toBe("spec_review");
    expect(JSON.stringify(chatRequests().at(-1)!.body.messages)).toContain("Добавь раздел про ошибки");
  });
});

describe("a question instead of a task", () => {
  const answer = call("answer", { answer: "Это небольшой проект: **math.js** с функцией add и тест к ней." });

  it("answers in the interview and stops: no spec, no checks, nothing to review", async () => {
    const { id } = await start([call("read_file", { path: "math.js" }), answer]);
    const done = await waitFor(id, status("done_empty"));
    expect(done).toMatchObject({ statusReason: "answered", summary: expect.stringContaining("math.js"), spec: null, checks: [] });
    expect(chatRequests()).toHaveLength(2);
    const tools = chatRequests()[0]!.body.tools.map((t: any) => t.function.name);
    expect(tools).toContain("answer");
    expect(tools).not.toContain("write_file");
    expect(tools).toEqual(expect.arrayContaining(["web_search", "open_page"]));
  });

  it("answers in the spec step when there is no interview", async () => {
    const { id } = await start([answer], { interview: false });
    expect(await waitFor(id, status("done_empty"))).toMatchObject({ statusReason: "answered" });
  });

  it("takes a follow-up question on the same task", async () => {
    const { id } = await start([answer, call("answer", { answer: "Тестов один." })]);
    await waitFor(id, status("done_empty"));
    expect((await env.call("POST", `/api/tasks/${id}/feedback`, { note: "Сколько там тестов?", comments: [] })).status).toBe(200);
    const again = await waitFor(id, (t) => t.status === "done_empty" && t.summary === "Тестов один.");
    expect(again.statusReason).toBe("answered");
  });
});

describe("the gate", () => {
  it("refuses to call red work done and feeds the failure back", async () => {
    const { id } = await start(
      [
        spec(),
        call("write_file", { path: "math.test.js", content: TEST_BOTH }),
        finish("Готово, честно"),
        call("write_file", { path: "math.js", content: MATH_BOTH }),
        finish("Теперь правда готово"),
      ],
      { interview: false, approveSpec: false, testsFirst: false },
    );
    const done = await waitFor(id, status("review"));
    expect(done.summary).toBe("Теперь правда готово");
    const fed = JSON.stringify(chatRequests()[3]!.body.messages);
    expect(fed).toContain("node --test");
    expect(fed).toMatch(/subtract/);
  });

  it("asks for real failing tests when the new tests already pass", async () => {
    const { id } = await start(
      [
        spec(),
        finish("Тесты написаны"),
        call("write_file", { path: "math.test.js", content: TEST_BOTH }),
        finish("Теперь тесты падают"),
        call("write_file", { path: "math.js", content: MATH_BOTH }),
        finish(),
      ],
      { interview: false, approveSpec: false },
    );
    await waitFor(id, status("review"));
    expect(JSON.stringify(chatRequests()[2]!.body.messages)).toMatch(/already pass/);
  });

  it("escalates to the strong model after three red runs, then reports being stuck", async () => {
    const red = () => finish("Готово");
    const { id, providerId } = await start(
      [spec(['node -e "process.exit(1)"']), red(), red(), red(), red(), red(), red()],
      { interview: false, approveSpec: false, testsFirst: false },
      [{ id: "strong" }],
    );
    await env.call("PATCH", "/api/settings", { strongModel: { providerId, model: "strong" } });
    const stuck = await waitFor(id, waiting("stuck"));
    expect(stuck).toMatchObject({ model: "strong", escalated: true });
    expect(chatRequests().map((r) => r.body.model)).toEqual(["coder", "coder", "coder", "coder", "strong", "strong", "strong"]);
    expect((await events(id)).some((e) => e.kind === "escalation")).toBe(true);
  });

  it("reports being stuck right away when no strong model is set", async () => {
    const red = () => finish("Готово");
    const { id } = await start([spec(['node -e "process.exit(1)"']), red(), red(), red()], {
      interview: false,
      approveSpec: false,
      testsFirst: false,
    });
    const stuck = await waitFor(id, waiting("stuck"));
    expect(stuck.escalated).toBe(false);
    const last = (await events(id)).filter((e) => e.kind === "status").at(-1);
    expect(last.data.detail).toContain('node -e "process.exit(1)"');
  });

  it("tries three more times when the user continues a stuck task", async () => {
    const red = () => finish("Готово");
    const { id } = await start([spec(['node -e "process.exit(1)"']), red(), red(), red(), red()], {
      interview: false,
      approveSpec: false,
      testsFirst: false,
    });
    await waitFor(id, waiting("stuck"));
    const before = chatRequests().length;
    await env.call("POST", `/api/tasks/${id}/continue`, {});
    await waitFor(id, (t) => t.status === "running");
    const again = await waitFor(id, waiting("stuck"));
    expect(again.attempts).toBe(3);
    expect(chatRequests().length - before).toBe(3);
  });

  it("drops risky checks from a spec nobody approved", async () => {
    const { id } = await start([spec(["node --test", "git push origin main"]), finish()], {
      interview: false,
      approveSpec: false,
      testsFirst: false,
    });
    const done = await waitFor(id, (t) => t.status === "review" || t.status === "done_empty");
    expect(done.checks).toEqual(["node --test"]);
  });

  it("reviews without checks when the user removed them all", async () => {
    const { id } = await start([spec(), finish()], { interview: false, testsFirst: false });
    await waitFor(id, waiting("spec_review"));
    await env.call("POST", `/api/tasks/${id}/spec`, { spec: "# Без проверок", checks: [] });
    const done = await waitFor(id, (t) => t.status === "review" || t.status === "done_empty");
    expect(done.checks).toEqual([]);
    expect((await events(id)).some((e) => e.kind === "check")).toBe(false);
  });
});
