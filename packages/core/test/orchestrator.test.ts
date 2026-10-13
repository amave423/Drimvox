import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { git, makeRepo } from "./git-repo";

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider | undefined;
let repo: string;

beforeEach(() => {
  env = createTestEnv();
  repo = makeRepo({ "package.json": '{ "type": "module" }\n', "README.md": "# Demo\n" });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>, delayMs?: number): FakeTurn => ({ toolCalls: [{ name, args }], delayMs });
const write = (path: string, content: string, delayMs?: number) => call("write_file", { path, content }, delayMs);
const finish = (summary: string) => call("finish", { summary, commit_message: summary });
const testFile = (name: string) =>
  `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ${name} } from "./${name}.js";\ntest("${name}", () => assert.ok(${name}));\n`;

/** One subtask that adds `<name>.js` and a test for it. */
const addModule = (name: string, delayMs?: number): FakeTurn[] => [
  write(`${name}.js`, `export const ${name} = true;\n`, delayMs),
  write(`${name}.test.js`, testFile(name)),
  finish(`${name} готов`),
];

interface Planned {
  id: string;
  title?: string;
  description?: string;
  dependsOn?: string[];
  checks?: string[];
}

const plan = (subtasks: Planned[], checks = ["node --test"], requirements: unknown[] = []) =>
  call("propose_plan", {
    spec: "# Цель\n\nНесколько модулей.",
    checks,
    requirements,
    commit_message: "Add the modules",
    subtasks: subtasks.map((s) => ({ title: `Модуль ${s.id}`, description: `Сделай ${s.id}.js и тест`, dependsOn: [], ...s })),
  });

/** Answers the lead model from its own script, every subtask from the script under its id, the acceptance agent from its own. */
function team(lead: FakeTurn[], subs: Record<string, FakeTurn[]>, acceptor: FakeTurn[] = []) {
  const leadQueue = [...lead];
  const acceptorQueue = [...acceptor];
  const queues = Object.fromEntries(Object.entries(subs).map(([k, v]) => [k, [...v]]));
  return (body: any): FakeTurn => {
    if (/acceptance agent/i.test(JSON.stringify(body.messages?.[0]?.content ?? ""))) return acceptorQueue.shift() ?? { text: "Done." };
    if (body.model === "lead") return leadQueue.shift() ?? { text: "Done." };
    const id = JSON.stringify(body.messages).match(/Subtask id: ([\w-]+)/)?.[1] ?? "";
    return queues[id]?.shift() ?? { text: "Done." };
  };
}

async function startGoal(respond: (body: any) => FakeTurn, approvePlan = true, preset: "custom" | "deepseek" = "custom") {
  fake = await startFakeProvider({ key: KEY, respond, models: [{ id: "lead" }, { id: "coder" }] });
  if (preset === "deepseek") env.setPresetUrl("deepseek", fake.baseUrl);
  const provider = await (
    await env.call("POST", "/api/providers", preset === "custom" ? { preset, baseUrl: fake.baseUrl, apiKey: KEY } : { preset, apiKey: KEY })
  ).json();
  const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
  const res = await env.call("POST", `/api/projects/${project.id}/tasks`, {
    task: "Добавь модули",
    providerId: provider.id,
    model: "lead",
    team: { providerId: provider.id, model: "coder" },
    stages: { interview: false, spec: true, approveSpec: approvePlan, testsFirst: false },
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

async function waitFor(id: string, check: (task: any) => boolean, timeoutMs = 20_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const task = await (await env.call("GET", `/api/tasks/${id}`)).json();
    if (check(task)) return task;
    if (Date.now() > until) {
      // A failed subtask says why in its last status event.
      const failed = task.subtasks?.find((s: any) => s.status === "failed");
      const why = failed ? (await events(failed.taskId)).filter((e) => e.kind === "status").at(-1)?.data?.detail : "";
      throw new Error(`stuck: ${task.status}/${task.statusReason} ${JSON.stringify(task.subtasks?.map((s: any) => [s.id, s.status, s.statusReason]))} ${why ?? ""}`);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}
const goalIs = (status: string, reason?: string) => (t: any) => t.status === status && (reason === undefined || t.statusReason === reason);
const approve = async (id: string, edit?: (plan: any) => any) => {
  const task = await waitFor(id, goalIs("waiting", "plan_review"));
  const body = { spec: task.spec, checks: task.checks, subtasks: task.plannedSubtasks };
  const res = await env.call("POST", `/api/tasks/${id}/plan`, edit ? edit(body) : body);
  expect(res.status).toBe(200);
};
const events = async (id: string) => (await (await env.call("GET", `/api/tasks/${id}/events`)).json()) as any[];

describe("planning", () => {
  it("shows the plan with subtasks and waits for the OK", async () => {
    const id = await startGoal(team([plan([{ id: "sub" }, { id: "mul", dependsOn: ["sub"] }])], {}));
    const task = await waitFor(id, goalIs("waiting", "plan_review"));
    expect(task).toMatchObject({ kind: "goal", phase: "spec", checks: ["node --test"], team: { model: "coder" } });
    expect(task.plannedSubtasks).toEqual([
      { id: "sub", title: "Модуль sub", description: "Сделай sub.js и тест", dependsOn: [], checks: [] },
      { id: "mul", title: "Модуль mul", description: "Сделай mul.js и тест", dependsOn: ["sub"], checks: [] },
    ]);
    expect(task.subtasks).toEqual([]);
  });

  it("drops dependencies on subtasks the user removed", async () => {
    const id = await startGoal(team([plan([{ id: "sub" }, { id: "mul", dependsOn: ["sub"] }])], { mul: addModule("mul") }));
    await approve(id, (p) => ({ ...p, subtasks: p.subtasks.filter((s: any) => s.id === "mul") }));
    const done = await waitFor(id, goalIs("review"));
    expect(done.subtasks.map((s: any) => [s.id, s.dependsOn])).toEqual([["mul", []]]);
  });
});

describe("the team at work", { timeout: 30_000 }, () => {
  it("runs independent subtasks, merges them and reviews the whole goal", async () => {
    const id = await startGoal(team([plan([{ id: "sub" }, { id: "mul" }])], { sub: addModule("sub"), mul: addModule("mul") }));
    await approve(id);
    const done = await waitFor(id, goalIs("review"));

    expect(done.subtasks.map((s: any) => [s.id, s.status])).toEqual([
      ["sub", "merged"],
      ["mul", "merged"],
    ]);
    const diff = await (await env.call("GET", `/api/tasks/${id}/diff`)).json();
    expect(diff.map((f: any) => f.path).sort()).toEqual(["mul.js", "mul.test.js", "sub.js", "sub.test.js"]);
    expect(existsSync(join(repo, "sub.js"))).toBe(false);

    const checks = (await events(id)).filter((e) => e.kind === "check" && e.data.phase === "integration");
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(checks.every((e) => e.data.ok)).toBe(true);
    const subtaskModels = fake!.requests.filter((r) => /Subtask id:/.test(JSON.stringify(r.body?.messages))).map((r) => r.body.model);
    expect(new Set(subtaskModels)).toEqual(new Set(["coder"]));

    // Seen live: the goal offered the whole task text as its commit message; the lead now writes one with the plan.
    expect(done.commitMessage).toBe("Add the modules");
    const accepted = await env.call("POST", `/api/tasks/${id}/accept`, { message: "Add sub and mul" });
    expect(accepted.status).toBe(200);
    expect(git(repo, "log", "--format=%s", "-1")).toBe("Add sub and mul");
    expect(readFileSync(join(repo, "mul.js"), "utf8")).toBe("export const mul = true;\n");
    expect(git(repo, "branch", "--list", "artel/*")).toBe("");
  });

  it("starts a subtask only after the ones it depends on are merged", async () => {
    const id = await startGoal(
      team([plan([{ id: "base" }, { id: "next", dependsOn: ["base"] }])], {
        base: addModule("base"),
        next: [call("read_file", { path: "base.js" }), ...addModule("next")],
      }),
    );
    await approve(id);
    await waitFor(id, goalIs("review"));
    const readBase = (await events((await waitFor(id, () => true)).subtasks[1].taskId)).find((e) => e.kind === "tool_result");
    expect(readBase.data).toMatchObject({ ok: true });
    expect(readBase.data.output).toContain("export const base = true");
  });

  // Thinking is paid as output and, with tools, comes back as input on every later step: workers do without it.
  it("lets team workers on DeepSeek work without thinking, while the lead keeps it", async () => {
    const id = await startGoal(team([plan([{ id: "sub" }])], { sub: addModule("sub") }), false, "deepseek");
    await waitFor(id, goalIs("review"));
    const chats = fake!.requests.filter((r) => r.path === "/v1/chat/completions");
    const workers = chats.filter((r) => r.body.model === "coder");
    const lead = chats.filter((r) => r.body.model === "lead");
    expect(workers.length).toBeGreaterThan(0);
    expect(workers.every((r) => r.body.thinking?.type === "disabled")).toBe(true);
    expect(lead.every((r) => r.body.thinking === undefined)).toBe(true);
  });

  it("never runs more than three subtasks at once", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const id = await startGoal(team([plan(ids.map((x) => ({ id: x })))], Object.fromEntries(ids.map((x) => [x, addModule(x, 300)]))));
    await approve(id);
    let most = 0;
    let task: any;
    for (;;) {
      task = await (await env.call("GET", `/api/tasks/${id}`)).json();
      most = Math.max(most, task.subtasks.filter((s: any) => s.status === "running").length);
      // Any stop ends the watch; a goal that stopped short shows up in the expectation below, not as a hang.
      if (task.status !== "running") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(task.status).toBe("review");
    expect(most).toBe(3);
  }, 60_000);

  it("rebuilds a subtask on top of the goal when its merge conflicts", async () => {
    const id = await startGoal(
      team([plan([{ id: "one" }, { id: "two" }], [])], {
        one: [write("shared.txt", "one\n", 50), finish("one")],
        two: [write("shared.txt", "two\n", 400), finish("two"), call("read_file", { path: "shared.txt" }), write("shared.txt", "one\ntwo\n"), finish("two again")],
      }),
    );
    await approve(id);
    const done = await waitFor(id, goalIs("review"));
    expect(done.subtasks.map((s: any) => s.status)).toEqual(["merged", "merged"]);
    const log = (await events(id)).filter((e) => e.kind === "subtask").map((e) => [e.data.id, e.data.action]);
    expect(log).toContainEqual(["two", "conflict"]);
    const diff = await (await env.call("GET", `/api/tasks/${id}/diff`)).json();
    expect(diff[0].hunks[0].lines.filter((l: any) => l.kind === "add").map((l: any) => l.text)).toEqual(["one", "two"]);
  });

  it("accepts the whole goal against its requirements and sends what is missing to a fix subtask", async () => {
    const requirements = [
      { id: "R1", text: "Есть модули sub и mul с тестами", verify: "check", how: "node --test" },
      { id: "R2", text: "README.md описывает оба модуля", verify: "review", how: "прочитать README.md" },
    ];
    const verdict = (r2: string) =>
      call("report_acceptance", {
        results: [
          { id: "R1", status: "done", evidence: "node --test", problem: "" },
          { id: "R2", status: r2, evidence: "README.md", problem: r2 === "done" ? "" : "README.md нет" },
        ],
        summary: r2 === "done" ? "Принято" : "Нет README",
      });
    const id = await startGoal(
      team(
        [plan([{ id: "sub" }, { id: "mul" }], ["node --test"], requirements)],
        { sub: addModule("sub"), mul: addModule("mul"), "fix-1": [write("README.md", "# sub и mul\n"), finish("README")] },
        [verdict("missing"), verdict("done")],
      ),
    );
    await approve(id);
    const done = await waitFor(id, goalIs("review"));
    expect(done.statusReason).toBeNull();
    expect(done.requirements.map((r: any) => r.id)).toEqual(["R1", "R2"]);
    expect(done.acceptance).toMatchObject({ round: 2, summary: "Принято" });
    expect(done.subtasks.map((s: any) => [s.id, s.status])).toEqual([
      ["sub", "merged"],
      ["mul", "merged"],
      ["fix-1", "merged"],
    ]);
    const fix = await (await env.call("GET", `/api/tasks/${done.subtasks[2].taskId}`)).json();
    expect(fix.task).toContain("README.md нет");
  });

  it("runs a goal in stages: the next stage's subtasks start only after the stage before is accepted", async () => {
    const requirements = [
      { id: "R1", text: "Есть модуль sub", verify: "check", how: "node --test", stage: 1 },
      { id: "R2", text: "Есть модуль mul", verify: "check", how: "node --test", stage: 2 },
    ];
    const verdict = (ids: string[]) =>
      call("report_acceptance", { results: ids.map((id) => ({ id, status: "done", evidence: "ok", problem: "" })), summary: ids.join(" ") });
    const staged = call("propose_plan", {
      spec: "# Цель",
      checks: ["node --test"],
      requirements,
      stages: [{ title: "Вычитание" }, { title: "Умножение" }],
      subtasks: [
        { id: "sub", title: "Модуль sub", description: "Сделай sub.js и тест", stage: 1 },
        { id: "mul", title: "Модуль mul", description: "Сделай mul.js и тест", stage: 2 },
      ],
    });
    const id = await startGoal(team([staged], { sub: addModule("sub"), mul: addModule("mul") }, [verdict(["R1"]), verdict(["R1", "R2"])]), false);
    const done = await waitFor(id, goalIs("review"));
    expect(done).toMatchObject({ milestone: 2, statusReason: null });
    expect(done.milestones).toEqual([{ title: "Вычитание" }, { title: "Умножение" }]);
    const flow = (await events(id))
      .filter((e) => (e.kind === "subtask" && e.data.action === "started") || e.kind === "milestone")
      .map((e) => (e.kind === "milestone" ? `stage ${e.data.stage} accepted` : `${e.data.id} started`));
    expect(flow).toEqual(["sub started", "stage 1 accepted", "mul started"]);
  });

  it("adds a fix subtask when the goal's checks go red after a merge", async () => {
    // Each subtask passes alone; only the two files together break the goal's check.
    // unlinkSync, not rmSync: on Node 24.11 rmSync silently keeps files under non-ASCII paths.
    const bothExist = `node -e "const f = require('fs'); process.exit(f.existsSync('a.txt') && f.existsSync('b.txt') ? 1 : 0)"`;
    const id = await startGoal(
      team([plan([{ id: "one" }, { id: "two" }], [bothExist])], {
        one: [write("a.txt", "a"), finish("one")],
        two: [write("b.txt", "b", 300), finish("two")],
        "fix-1": [call("run_command", { command: `node -e "require('fs').unlinkSync('b.txt')"` }), finish("fixed")],
      }),
    );
    await approve(id);
    const done = await waitFor(id, goalIs("review"));
    expect(done.subtasks.map((s: any) => [s.id, s.status])).toEqual([
      ["one", "merged"],
      ["two", "merged"],
      ["fix-1", "merged"],
    ]);
    const integration = (await events(id)).filter((e) => e.kind === "check" && e.data.phase === "integration").map((e) => e.data.ok);
    expect(integration).toContain(false);
    expect(integration.at(-1)).toBe(true);
  });

  it("waits for the user when a subtask gets stuck, and goes on after it is continued", async () => {
    const red = `node -e "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"`;
    const id = await startGoal(
      team([plan([{ id: "one" }], [red])], {
        one: [finish("try 1"), finish("try 2"), finish("try 3"), write("ok.txt", "ok"), finish("now")],
      }),
    );
    await approve(id);
    const waiting = await waitFor(id, goalIs("waiting", "subtask_stuck"));
    const sub = waiting.subtasks[0];
    expect(sub).toMatchObject({ id: "one", status: "waiting", statusReason: "stuck" });
    await env.call("POST", `/api/tasks/${sub.taskId}/continue`, {});
    const done = await waitFor(id, goalIs("review"));
    expect(done.subtasks[0].status).toBe("merged");
  });
});

describe("checks of subtasks and of the goal", { timeout: 30_000 }, () => {
  const exists = (...files: string[]) =>
    `node -e "const f = require('fs'); process.exit(${files.map((x) => `f.existsSync('${x}')`).join(" && ")} ? 0 : 1)"`;

  it("gates each subtask on its own checks and the goal on the goal's checks", async () => {
    const id = await startGoal(
      team([plan([{ id: "one", checks: [exists("one.txt")] }, { id: "two", checks: [exists("two.txt")] }], [exists("one.txt", "two.txt")])], {
        one: [write("one.txt", "1"), finish("one")],
        two: [write("two.txt", "2", 300), finish("two")],
      }),
    );
    await approve(id);
    const done = await waitFor(id, goalIs("review"));
    expect(done.subtasks.map((s: any) => [s.id, s.status])).toEqual([
      ["one", "merged"],
      ["two", "merged"],
    ]);
    const own = (await events(done.subtasks[0].taskId)).filter((e) => e.kind === "check").map((e) => e.data.command);
    expect(own).toEqual([exists("one.txt")]);
    const integration = (await events(id)).filter((e) => e.kind === "check" && e.data.phase === "integration");
    expect(integration.every((e) => e.data.ok)).toBe(true);
    expect(integration.at(-1).data.command).toBe(exists("one.txt", "two.txt"));
    expect(integration.find((e) => e.data.command === exists("one.txt", "two.txt"))).toBe(integration.at(-1));
  });
});

describe("dropping a subtask", { timeout: 30_000 }, () => {
  it("takes a stuck subtask out of the goal and starts the ones that waited for it", async () => {
    const red = `node -e "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"`;
    const id = await startGoal(
      team([plan([{ id: "one" }, { id: "two" }, { id: "three", dependsOn: ["one"] }], [red])], {
        one: [finish("try 1"), finish("try 2"), finish("try 3")],
        two: [write("ok.txt", "ok"), finish("two")],
        three: [write("three.txt", "3"), finish("three")],
      }),
    );
    await approve(id);
    const stuck = await waitFor(id, (t) => t.statusReason === "subtask_stuck" && t.subtasks[1].status === "merged");
    expect(stuck.subtasks[2].status).toBe("queued");

    expect((await env.call("POST", `/api/tasks/${stuck.subtasks[0].taskId}/drop`)).status).toBe(200);
    const done = await waitFor(id, goalIs("review"));
    expect(done.subtasks.map((s: any) => [s.id, s.status, s.dependsOn])).toEqual([
      ["one", "discarded", []],
      ["two", "merged", []],
      ["three", "merged", []],
    ]);
    const diff = await (await env.call("GET", `/api/tasks/${id}/diff`)).json();
    expect(diff.map((f: any) => f.path).sort()).toEqual(["ok.txt", "three.txt"]);
  });

  it("refuses to drop a goal or a subtask that is working", async () => {
    const id = await startGoal(team([plan([{ id: "one" }], [])], { one: [write("a.txt", "a", 1500), finish("one")] }));
    await approve(id);
    const working = await waitFor(id, (t) => t.subtasks[0]?.status === "running");
    expect((await env.call("POST", `/api/tasks/${working.subtasks[0].taskId}/drop`)).status).toBe(409);
    expect((await env.call("POST", `/api/tasks/${id}/drop`)).status).toBe(409);
    await waitFor(id, goalIs("review"));
  });
});

describe("stopping a goal", { timeout: 30_000 }, () => {
  it("stops every subtask with the goal, and Continue picks them up again", async () => {
    // The first turn of each subtask is cut off by Stop; the rest of the script runs after Continue.
    const id = await startGoal(
      team([plan([{ id: "one" }, { id: "two" }], [])], {
        one: [write("one.txt", "1", 2000), write("one.txt", "1"), finish("one")],
        two: [write("two.txt", "2", 2000), write("two.txt", "2"), finish("two")],
      }),
    );
    await approve(id);
    await waitFor(id, (t) => t.subtasks.filter((s: any) => s.status === "running").length === 2);
    expect((await env.call("POST", `/api/tasks/${id}/stop`)).status).toBe(200);
    const stopped = await waitFor(id, (t) => t.status === "stopped" && t.subtasks.every((s: any) => s.status === "stopped"));
    expect(stopped.statusReason).toBe("user");

    // The subtasks' runs wind down a moment after their status changes.
    for (let i = 0; (await env.call("POST", `/api/tasks/${id}/continue`, {})).status !== 200; i++) {
      if (i > 50) throw new Error("continue refused");
      await new Promise((r) => setTimeout(r, 40));
    }
    const done = await waitFor(id, goalIs("review"));
    expect(done.subtasks.map((s: any) => s.status)).toEqual(["merged", "merged"]);
  });
});

describe("the end of a goal", () => {
  it("discarding removes the goal and every subtask copy", async () => {
    const id = await startGoal(team([plan([{ id: "sub" }])], { sub: addModule("sub") }));
    await approve(id);
    await waitFor(id, goalIs("review"));
    expect((await env.call("POST", `/api/tasks/${id}/discard`)).status).toBe(200);
    expect(git(repo, "branch", "--list", "artel/*")).toBe("");
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("keeps subtasks out of the task list and adds their cost to the goal", async () => {
    const id = await startGoal(team([plan([{ id: "sub" }])], { sub: addModule("sub") }));
    await approve(id);
    const done = await waitFor(id, goalIs("review"));
    const list = await (await env.call("GET", "/api/tasks")).json();
    expect(list.map((t: any) => t.id)).toEqual([id]);
    expect(done.steps).toBeGreaterThan(3);
  });
});
