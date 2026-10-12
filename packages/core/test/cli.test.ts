import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { makeRepo } from "./git-repo";

const FAKE = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));
const MATH = "export function add(a, b) {\n  return a + b;\n}\n";
const TEST_ADD = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./math.js";\n\ntest("add", () => assert.equal(add(2, 3), 5));\n';

let env: TestEnv;
let dir: string;
let repo: string;

interface Turn {
  text?: string;
  json?: unknown;
  error?: string;
  session?: string;
  files?: Record<string, string>;
  tools?: { name: string; input: Record<string, unknown>; output?: string; error?: boolean }[];
}

beforeEach(() => {
  env = createTestEnv();
  dir = mkdtempSync(join(tmpdir(), "artel-fake-cli-"));
  process.env.FAKE_CLI_DIR = dir;
  for (const [id, kind] of [["claude-code", "claude"], ["codex", "codex"], ["gemini-cli", "gemini"]] as const) {
    env.setCliCommand(id, [process.execPath, FAKE, kind]);
  }
  repo = makeRepo({ "package.json": '{ "type": "module" }\n', "math.js": MATH, "math.test.js": TEST_ADD });
});

afterEach(async () => {
  await env.closeAsync();
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const script = (turns: Turn[]) => writeFileSync(join(dir, "script.json"), JSON.stringify(turns));
const calls = (): { kind: string; args: string[]; prompt: string; cwd: string }[] =>
  existsSync(join(dir, "calls.jsonl"))
    ? readFileSync(join(dir, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];

async function connect(preset: string) {
  const res = await env.call("POST", "/api/providers", { preset });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

async function say(chatId: string, content: string) {
  return (await readEvents(await env.call("POST", `/api/chats/${chatId}/messages`, { content, web: "off" }))).find((e) => e.type === "done").message;
}

describe("connecting", () => {
  it("offers the CLI's models and bills by subscription", async () => {
    const id = await connect("claude-code");
    const provider = (await (await env.call("GET", "/api/providers")).json()).find((p: any) => p.id === id);
    expect(provider).toMatchObject({ preset: "claude-code", billing: "subscription", hasKey: false });
    const models = await (await env.call("GET", `/api/providers/${id}/models`)).json();
    expect(models.map((m: any) => m.id)).toEqual(["default", "haiku", "opus", "sonnet"]);
    expect(models[0]).toMatchObject({ priceIn: 0, priceOut: 0, tools: true });
  });

  it("says when the program is not installed", async () => {
    env.setCliCommand("codex", [join(dir, "no-such-codex.exe")]);
    const id = await connect("codex");
    const res = await env.call("GET", `/api/providers/${id}/models`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatchObject({ code: "cli_missing" });
  });
});

describe("chat", () => {
  it("answers through the CLI, read-only, and continues the same session", async () => {
    script([{ text: "Привет из Claude Code", session: "s-chat" }, { text: "Второй ответ", session: "s-chat" }]);
    const id = await connect("claude-code");
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "sonnet" })).json();
    expect(await say(chat.id, "Привет")).toMatchObject({ status: "done", content: "Привет из Claude Code", inputTokens: 120, outputTokens: 30, costUsd: 0 });
    expect(await say(chat.id, "Ещё")).toMatchObject({ content: "Второй ответ" });

    const [first, second] = calls();
    expect(first!.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--model", "sonnet", "--permission-mode", "dontAsk"]));
    expect(first!.args).not.toContain("Bash");
    expect(first!.prompt).toContain("Привет");
    expect(second!.args).toEqual(expect.arrayContaining(["--resume", "s-chat"]));
    expect(second!.prompt).toContain("Ещё");
    expect(second!.prompt).not.toContain("Привет");
  });

  it("tells the user to log in when the CLI is not logged in", async () => {
    script([{ error: "Not logged in · Please run /login" }]);
    const id = await connect("claude-code");
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "default" })).json();
    expect(await say(chat.id, "Привет")).toMatchObject({ status: "error", error: { code: "cli_login" } });
    expect(calls()[0]!.args).not.toContain("--model");
  });

  it("works with Gemini CLI too", async () => {
    script([{ text: "Привет из Gemini" }]);
    const id = await connect("gemini-cli");
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "flash" })).json();
    expect(await say(chat.id, "Привет")).toMatchObject({ status: "done", content: "Привет из Gemini" });
    expect(calls()[0]!.args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "-m", "flash", "--approval-mode", "default"]));
  });
});

describe("tasks", () => {
  async function start(preset: string, stages: Record<string, boolean>) {
    const id = await connect(preset);
    const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
    const task = await (
      await env.call("POST", `/api/projects/${project.id}/tasks`, {
        task: "Добавь subtract(a, b) с тестом",
        providerId: id,
        model: "default",
        stages: { interview: false, spec: false, approveSpec: false, testsFirst: false, ...stages },
      })
    ).json();
    return task.id as string;
  }
  const waitTask = async (id: string, check: (t: any) => boolean) => {
    for (let i = 0; i < 600; i++) {
      const t = await (await env.call("GET", `/api/tasks/${id}`)).json();
      if (check(t)) return t;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("task stuck");
  };
  const events = async (id: string) => (await (await env.call("GET", `/api/tasks/${id}/events`)).json()) as any[];
  const spec = { tool: "propose_spec", input: { spec: "# Вычитание", checks: ["node --test"], plan: ["Функция", "Тест"] } };
  const subtract = {
    "math.js": `${MATH}export function subtract(a, b) {\n  return a - b;\n}\n`,
    "math.test.js": `${TEST_ADD.replace("{ add }", "{ add, subtract }")}test("subtract", () => assert.equal(subtract(5, 3), 2));\n`,
  };

  it("writes the spec as JSON, codes in the copy, passes the checks and lands in review", async () => {
    script([
      // Claude Code hands in its JSON answer through a tool of its own; that is not work to show.
      { json: spec, session: "s-task", tools: [{ name: "StructuredOutput", input: spec }] },
      {
        session: "s-task",
        files: subtract,
        tools: [
          { name: "Edit", input: { file_path: "math.js" } },
          { name: "Bash", input: { command: "node --test" }, output: "pass 2" },
        ],
        text: "Добавил subtract и тест.\nCOMMIT: Add subtract",
      },
    ]);
    const id = await start("claude-code", { spec: true });
    const done = await waitTask(id, (t) => t.status === "review");
    expect(done).toMatchObject({ spec: "# Вычитание", checks: ["node --test"], commitMessage: "Add subtract", summary: "Добавил subtract и тест." });

    const [specTurn, codeTurn] = calls();
    expect(specTurn!.args).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk", "--json-schema"]));
    expect(specTurn!.prompt).toContain("propose_spec");
    expect(codeTurn!.args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits", "--resume", "s-task", "--disallowedTools"]));
    expect(codeTurn!.args.join(" ")).toContain("Bash(git push:*)");
    expect(codeTurn!.cwd).not.toBe(repo);

    const feed = await events(id);
    expect(feed.filter((e) => e.kind === "tool_call").map((e) => e.data.name)).toEqual(["edit_file", "run_command"]);
    expect(feed.find((e) => e.kind === "tool_call" && e.data.name === "run_command").data.input).toEqual({ command: "node --test" });
    expect(feed.filter((e) => e.kind === "check").map((e) => e.data.ok)).toEqual([true]);
  });

  it("sends red checks back to the same session", async () => {
    script([
      { json: spec },
      { text: "Готово.\nCOMMIT: Try", files: { "math.test.js": `${TEST_ADD}test("fails", () => assert.equal(1, 2));\n` } },
      { text: "Починил.\nCOMMIT: Fix", files: subtract },
    ]);
    const id = await start("claude-code", { spec: true });
    await waitTask(id, (t) => t.status === "review");
    const third = calls()[2]!;
    expect(third.args).toEqual(expect.arrayContaining(["--resume", "sess-1"]));
    expect(third.prompt).toMatch(/checks .*fail/i);
  });

  it("answers a question without a spec", async () => {
    script([{ json: { tool: "answer", input: { answer: "Это проект с math.js." } } }]);
    const id = await start("claude-code", { interview: true, spec: true });
    expect(await waitTask(id, (t) => t.status === "done_empty")).toMatchObject({ statusReason: "answered", summary: "Это проект с math.js." });
  });

  it("runs Codex in its sandbox and shows its commands", async () => {
    script([{ text: "Готово.\nCOMMIT: Add subtract", files: subtract, tools: [{ name: "command", input: { command: "node --test" }, output: "ok" }] }]);
    const id = await start("codex", {});
    await waitTask(id, (t) => t.status === "review");
    expect(calls()[0]!.args).toEqual(expect.arrayContaining(["exec", "--json", "--sandbox", "workspace-write"]));
    const call = (await events(id)).find((e) => e.kind === "tool_call");
    expect(call.data).toMatchObject({ name: "run_command", input: { command: "node --test" } });
  });

  it("fails clearly when the CLI stops with an error", async () => {
    script([{ error: "Internal error" }]);
    const id = await start("gemini-cli", {});
    const failed = await waitTask(id, (t) => t.status === "failed");
    expect(failed.statusReason).toBe("provider_error");
  });
});
