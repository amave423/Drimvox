import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { tmpdir } from "node:os";
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
  repo = makeRepo({ "src/app.ts": "export const greeting = 'hi';\n", "README.md": "# Demo\n" });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(repo, { recursive: true, force: true });
});

const finish = (summary = "Done", commit_message = "Add hello file") => ({ name: "finish", args: { summary, commit_message } });

async function setup(script: FakeTurn[], models: Record<string, unknown>[] = [{ id: "coder" }]) {
  fake = await startFakeProvider({ key: KEY, script, models });
  const provider = await (
    await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })
  ).json();
  const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
  return { provider, project };
}

async function startTask(task = "Создай hello.txt") {
  const { provider, project } = await setupResult!;
  // These tests cover the agent itself; the interview/spec/tests steps have their own suite.
  const stages = { interview: false, spec: false, approveSpec: false, testsFirst: false };
  const res = await env.call("POST", `/api/projects/${project.id}/tasks`, { task, providerId: provider.id, model: "coder", stages });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

let setupResult: ReturnType<typeof setup> | undefined;

async function waitFor(id: string, statuses: string[], timeoutMs = 15_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const task = await (await env.call("GET", `/api/tasks/${id}`)).json();
    if (statuses.includes(task.status)) return task;
    if (Date.now() > until) throw new Error(`task stuck in ${task.status} (${task.statusReason ?? ""})`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

const events = async (id: string) => (await (await env.call("GET", `/api/tasks/${id}/events`)).json()) as any[];

describe("projects", () => {
  it("adds a git repository", async () => {
    const res = await env.call("POST", "/api/projects", { path: repo });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ path: repo, gitState: "ready" });
  });

  // Seen live: git appeared in the user's folder though nobody asked. A plain folder stays plain until the user agrees on
  // the project's page; then it gets git, dependencies left out.
  it("starts git in a plain folder only when the user asks", async () => {
    const plain = mkdtempSync(join(tmpdir(), "drimvox-plain-"));
    writeFileSync(join(plain, "notes.txt"), "hello");
    mkdirSync(join(plain, "node_modules", "x"), { recursive: true });
    writeFileSync(join(plain, "node_modules", "x", "index.js"), "x");
    const added = await (await env.call("POST", "/api/projects", { path: plain })).json();
    expect(added.gitState).toBe("not_repo");
    expect(existsSync(join(plain, ".git"))).toBe(false);
    const project = await (await env.call("POST", `/api/projects/${added.id}/init-git`)).json();
    expect(project.gitState).toBe("ready");
    expect(git(plain, "log", "--format=%s")).toBe("Initial commit");
    expect(git(plain, "show", "--name-only", "--format=")).toBe("notes.txt");
    rmSync(plain, { recursive: true, force: true });
  });

  it("commits under the computer's user name when git has none set", async () => {
    const plain = mkdtempSync(join(tmpdir(), "drimvox-plain-"));
    writeFileSync(join(plain, "notes.txt"), "hello");
    const empty = join(plain, "..", `drimvox-empty-gitconfig-${Date.now()}`);
    writeFileSync(empty, "");
    const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys.slice(2)) delete process.env[k];
    process.env.GIT_CONFIG_GLOBAL = empty;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const added = await (await env.call("POST", "/api/projects", { path: plain })).json();
      const project = await (await env.call("POST", `/api/projects/${added.id}/init-git`)).json();
      expect(project.gitState).toBe("ready");
      expect(git(plain, "log", "--format=%an")).toBe(userInfo().username);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(empty, { force: true });
      rmSync(plain, { recursive: true, force: true });
    }
  });

  // Seen: a project was called by its folder's name with no way to change it; chats could be renamed.
  it("renames a project without touching its folder", async () => {
    const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
    const res = await env.call("PATCH", `/api/projects/${project.id}`, { name: "  Сайт кофейни  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Сайт кофейни", path: repo });
    expect((await (await env.call("GET", "/api/projects")).json())[0].name).toBe("Сайт кофейни");
    expect((await env.call("PATCH", `/api/projects/${project.id}`, { name: " " })).status).toBe(400);
    expect((await env.call("PATCH", "/api/projects/nope", { name: "X" })).status).toBe(404);
  });

  it("refuses a folder that does not exist", async () => {
    const res = await env.call("POST", "/api/projects", { path: join(repo, "nope") });
    expect(res.status).toBe(400);
  });

  it("lists and removes projects without touching the folder", async () => {
    const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
    expect((await (await env.call("GET", "/api/projects")).json()).length).toBe(1);
    expect((await env.call("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    expect(existsSync(join(repo, "README.md"))).toBe(true);
  });
});

describe("a task", () => {
  it("works in its own copy and leaves the project untouched until review", async () => {
    setupResult = setup([
      { text: "Создаю файл.", toolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "Привет\n" } }] },
      { toolCalls: [finish("Добавил hello.txt")] },
    ]);
    const { id } = await startTask();
    const task = await waitFor(id, ["review"]);

    expect(task).toMatchObject({ summary: "Добавил hello.txt", commitMessage: "Add hello file", model: "coder" });
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);
    expect(git(repo, "branch", "--list", task.branch)).toContain(task.branch);

    const diff = await (await env.call("GET", `/api/tasks/${id}/diff`)).json();
    expect(diff.map((f: any) => [f.path, f.status])).toEqual([["hello.txt", "added"]]);

    const log = await events(id);
    expect(log.map((e) => e.kind)).toEqual(expect.arrayContaining(["user", "text", "tool_call", "tool_result"]));
    expect(log.find((e) => e.kind === "tool_call")).toMatchObject({ data: { name: "write_file", input: { path: "hello.txt" } } });
  });

  it("tells the model that the system is Windows or Unix and where it works", async () => {
    setupResult = setup([{ toolCalls: [finish()] }]);
    const { id } = await startTask("Посмотри проект");
    await waitFor(id, ["done_empty"]);
    const system = fake!.requests.find((r) => r.path === "/v1/chat/completions")?.body.messages[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain(process.platform === "win32" ? "PowerShell" : "sh");
  });

  it("starts every request with the project's AGENTS.md and lets the agent keep its notes there", async () => {
    writeFileSync(join(repo, "AGENTS.md"), "# Правила\nТолько TypeScript.\n");
    git(repo, "add", "AGENTS.md");
    git(repo, "commit", "-q", "-m", "Rules");
    setupResult = setup([
      { toolCalls: [{ name: "update_notes", args: { notes: "Приветствие в src/app.ts. Проверка: node --test." } }] },
      { toolCalls: [finish()] },
    ]);
    const { id } = await startTask("Запиши заметки");
    await waitFor(id, ["review"]);
    const systems = fake!.requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body.messages[0].content as string);
    expect(systems[0]).toContain("Только TypeScript.");
    expect(systems[1]).toContain("Приветствие в src/app.ts.");
    const diff = await (await env.call("GET", `/api/tasks/${id}/diff`)).json();
    expect(diff.map((f: any) => f.path)).toContain("AGENTS.md");
  });

  it("runs commands inside the copy", async () => {
    setupResult = setup([
      { toolCalls: [{ name: "run_command", args: { command: `node -e "require('fs').writeFileSync('built.txt','ok')"` } }] },
      { toolCalls: [finish()] },
    ]);
    const { id } = await startTask();
    await waitFor(id, ["review"]);
    expect(existsSync(join(repo, "built.txt"))).toBe(false);
    const result = (await events(id)).find((e) => e.kind === "tool_result");
    expect(result.data).toMatchObject({ ok: true });
  });

  it("turns a path outside the copy into an error for the model", async () => {
    const outside = join(repo, "..", "drimvox-escape.txt");
    setupResult = setup([
      { toolCalls: [{ name: "write_file", args: { path: "../drimvox-escape.txt", content: "x" } }] },
      { toolCalls: [finish()] },
    ]);
    const { id } = await startTask();
    await waitFor(id, ["done_empty"]);
    expect(existsSync(outside)).toBe(false);
    const result = (await events(id)).find((e) => e.kind === "tool_result");
    expect(result.data).toMatchObject({ ok: false });
    expect(result.data.output).toMatch(/outside/);
  });

  it("asks before a dangerous command and continues after an answer", async () => {
    setupResult = setup([
      { toolCalls: [{ name: "run_command", args: { command: "git push origin main" } }] },
      { toolCalls: [finish()] },
    ]);
    const { id } = await startTask();
    const waiting = await waitFor(id, ["waiting"]);
    expect(waiting.statusReason).toBe("approval");
    expect(waiting.pendingApproval).toMatchObject({ command: "git push origin main", reason: "push" });

    const answer = await env.call("POST", `/api/tasks/${id}/approvals/${waiting.pendingApproval.id}`, { allow: false });
    expect(answer.status).toBe(200);
    await waitFor(id, ["done_empty"]);
    const result = (await events(id)).find((e) => e.kind === "tool_result");
    expect(result.data.output).toMatch(/denied/i);
  });

  it("charges a task by the provider's own bill when it sends one", async () => {
    setupResult = setup(
      [
        { toolCalls: [{ name: "list_files", args: { path: "." } }], usage: { prompt_tokens: 600_000, completion_tokens: 10, cost: 0.03 } },
        { toolCalls: [finish()], usage: { prompt_tokens: 600_000, completion_tokens: 10, cost: 0.02 } },
      ],
      [{ id: "coder", pricing: { prompt: "0.000001", completion: "0.000002" } }],
    );
    const { id } = await startTask();
    const task = await waitFor(id, ["done_empty", "failed"]);
    // The catalog's prices would make it 1.2 $.
    expect(task.costUsd).toBeCloseTo(0.05, 6);
  });

  // Seen live: a task stopped at every 60 steps and asked to go on, with stops or on its own; only the budget should stop it.
  it("goes past the step limit by itself", async () => {
    const look = { toolCalls: [{ name: "list_files", args: { path: "." } }] };
    setupResult = setup([...Array(65).fill(look), { toolCalls: [finish()] }]);
    const { id } = await startTask();
    const task = await waitFor(id, ["done_empty", "waiting", "failed"], 30_000);
    expect(task).toMatchObject({ status: "done_empty" });
    expect((await events(id)).some((e) => e.kind === "text" && /continues on its own/.test(e.data.text))).toBe(true);
  });

  // Seen live: after the user's "Continue" the task stopped again at every 60 steps.
  it("goes past the step limit by itself again after the user says to continue", async () => {
    const look = { toolCalls: [{ name: "list_files", args: { path: "." } }] };
    setupResult = setup([...Array(240 + 70).fill(look), { toolCalls: [finish()] }]);
    const { id } = await startTask();
    expect(await waitFor(id, ["waiting", "done_empty", "failed"], 60_000)).toMatchObject({ status: "waiting", statusReason: "steps" });
    await env.call("POST", `/api/tasks/${id}/continue`, {});
    expect(await waitFor(id, ["waiting", "done_empty", "failed"], 60_000)).toMatchObject({ status: "done_empty" });
  }, 120_000);

  // Seen live: an answer given after two minutes failed the task with "timeout", as if the model had gone silent.
  it("waits for the user's answer longer than a model may stay silent", async () => {
    env.setIdleTimeout(300);
    setupResult = setup([{ toolCalls: [{ name: "run_command", args: { command: "git push origin main" } }] }, { toolCalls: [finish()] }]);
    const { id } = await startTask();
    const waiting = await waitFor(id, ["waiting"]);
    await new Promise((r) => setTimeout(r, 900));
    await env.call("POST", `/api/tasks/${id}/approvals/${waiting.pendingApproval.id}`, { allow: false });
    expect(await waitFor(id, ["done_empty", "failed"])).toMatchObject({ status: "done_empty" });
  });

  it("lets a long command run longer than a model may stay silent", async () => {
    env.setIdleTimeout(300);
    setupResult = setup([{ toolCalls: [{ name: "run_command", args: { command: 'node -e "setTimeout(() => {}, 1200)"' } }] }, { toolCalls: [finish()] }]);
    const { id } = await startTask();
    expect(await waitFor(id, ["done_empty", "failed"])).toMatchObject({ status: "done_empty" });
  });

  it("stops at the budget and continues when asked", async () => {
    setupResult = setup(
      [
        { toolCalls: [{ name: "list_files", args: { path: "." } }], usage: { prompt_tokens: 600_000, completion_tokens: 0 } },
        { toolCalls: [finish()] },
      ],
      [{ id: "coder", pricing: { prompt: "0.000001", completion: "0.000002" } }],
    );
    await env.call("PATCH", "/api/settings", { agentBudgetUsd: 0.5 });
    const { id } = await startTask();
    const waiting = await waitFor(id, ["waiting"]);
    expect(waiting).toMatchObject({ statusReason: "budget", budgetUsd: 0.5 });
    expect(waiting.costUsd).toBeCloseTo(0.6, 6);

    await env.call("POST", `/api/tasks/${id}/continue`, {});
    const done = await waitFor(id, ["done_empty"]);
    expect(done.budgetUsd).toBe(1);

    // Agent spending counts in the day's total next to chat answers.
    const usage = await (await env.call("GET", "/api/usage?since=0")).json();
    expect(usage.costUsd).toBeCloseTo(done.costUsd, 9);
    expect(usage.inputTokens).toBe(done.inputTokens);
  });

  it("can be stopped", async () => {
    setupResult = setup([{ delayMs: 3000, toolCalls: [finish()] }]);
    const { id } = await startTask();
    await waitFor(id, ["running"]);
    await env.call("POST", `/api/tasks/${id}/stop`);
    expect((await waitFor(id, ["stopped"])).status).toBe("stopped");
  });

  it("reports a provider error as a failed task", async () => {
    setupResult = setup([]);
    const { provider } = await setupResult;
    await env.call("PATCH", `/api/providers/${provider.id}`, { apiKey: "wrong" });
    const { id } = await startTask();
    const failed = await waitFor(id, ["failed"]);
    expect(failed.statusReason).toBe("bad_key");
  });
});

describe("review", () => {
  async function reviewed() {
    setupResult = setup([
      { toolCalls: [{ name: "edit_file", args: { path: "src/app.ts", old: "'hi'", new: "'hello'" } }] },
      { toolCalls: [finish("Поменял приветствие", "Change greeting to hello")] },
      { toolCalls: [{ name: "edit_file", args: { path: "src/app.ts", old: "'hello'", new: "'hello there'" } }] },
      { toolCalls: [finish("Учёл замечание", "Change greeting to hello there")] },
    ]);
    const { id } = await startTask("Поменяй приветствие");
    await waitFor(id, ["review"]);
    return id;
  }

  it("sends line comments back to the agent and keeps working in the same copy", async () => {
    const id = await reviewed();
    const res = await env.call("POST", `/api/tasks/${id}/feedback`, {
      note: "Почти",
      comments: [{ path: "src/app.ts", line: 1, text: "Сделай 'hello there'" }],
    });
    expect(res.status).toBe(200);
    const task = await waitFor(id, ["review"]);
    expect(task.summary).toBe("Учёл замечание");

    const lastRequest = fake!.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!.body.messages;
    const feedback = lastRequest.filter((m: any) => m.role === "user").at(-1).content;
    expect(feedback).toContain("src/app.ts:1");
    expect(feedback).toContain("Сделай 'hello there'");
    expect(lastRequest.some((m: any) => m.role === "tool")).toBe(true);

    const diff = await (await env.call("GET", `/api/tasks/${id}/diff`)).json();
    const added = diff[0].hunks[0].lines.filter((l: any) => l.kind === "add").map((l: any) => l.text);
    expect(added).toEqual(["export const greeting = 'hello there';"]);
  });

  it("accepts as one commit on the current branch and cleans up the copy", async () => {
    const id = await reviewed();
    const before = (await (await env.call("GET", `/api/tasks/${id}`)).json()) as { branch: string };
    const res = await env.call("POST", `/api/tasks/${id}/accept`, { message: "Change greeting" });
    expect(res.status).toBe(200);

    expect(readFileSync(join(repo, "src", "app.ts"), "utf8")).toBe("export const greeting = 'hello';\n");
    expect(git(repo, "log", "--format=%s", "-2")).toBe("Change greeting\nInitial commit");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(repo, "branch", "--list", before.branch)).toBe("");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect((await (await env.call("GET", `/api/tasks/${id}`)).json()).status).toBe("accepted");
  });

  it("refuses to accept over uncommitted edits of the same file", async () => {
    const id = await reviewed();
    writeFileSync(join(repo, "src", "app.ts"), "export const greeting = 'mine';\n");
    const res = await env.call("POST", `/api/tasks/${id}/accept`, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "dirty", files: ["src/app.ts"] } });
    expect(readFileSync(join(repo, "src", "app.ts"), "utf8")).toBe("export const greeting = 'mine';\n");
  });

  it("refuses to accept when the project changed the same lines meanwhile", async () => {
    const id = await reviewed();
    writeFileSync(join(repo, "src", "app.ts"), "export const greeting = 'yo';\n");
    git(repo, "commit", "-qam", "Change greeting myself");
    const res = await env.call("POST", `/api/tasks/${id}/accept`, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "conflict", files: ["src/app.ts"] } });
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("discards the copy and leaves the project as it was", async () => {
    const id = await reviewed();
    const { branch } = (await (await env.call("GET", `/api/tasks/${id}`)).json()) as { branch: string };
    expect((await env.call("POST", `/api/tasks/${id}/discard`)).status).toBe(200);
    expect(git(repo, "branch", "--list", branch)).toBe("");
    expect(readFileSync(join(repo, "src", "app.ts"), "utf8")).toBe("export const greeting = 'hi';\n");
    expect((await (await env.call("GET", `/api/tasks/${id}`)).json()).status).toBe("discarded");
  });
});

describe("recovery", () => {
  // Seen live: Dellmar answers 429 "too many concurrent requests" while another agent's request is in flight.
  it("waits out a provider that is briefly busy instead of failing the task", async () => {
    let busy = 2;
    fake = await startFakeProvider({
      key: KEY,
      script: [{ toolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "Привет\n" } }, finish()] }],
      models: [{ id: "coder" }],
      handle: (_method, path) =>
        path === "/v1/chat/completions" && busy-- > 0 ? { status: 429, json: { error: { message: "Too many concurrent requests" } } } : undefined,
    });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
    setupResult = Promise.resolve({ provider, project });
    const { id } = await startTask();
    expect(await waitFor(id, ["review", "failed"], 30_000)).toMatchObject({ status: "review" });
  }, 40_000);

  it("marks tasks cut off by a restart as stopped", async () => {
    setupResult = setup([{ delayMs: 5000, toolCalls: [finish()] }]);
    const { id } = await startTask();
    await waitFor(id, ["running"]);
    env.db.sql.prepare("update tasks set status = 'running' where id = ?").run(id);
    env.reopen();
    expect((await (await env.call("GET", `/api/tasks/${id}`)).json()).status).toBe("stopped");
  });
});
