import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";
import { startFakeProxy } from "./fake-proxy";
import { makeRepo } from "./git-repo";

const FAKE = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));
const MATH = "export function add(a, b) {\n  return a + b;\n}\n";
const TEST_ADD = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./math.js";\n\ntest("add", () => assert.equal(add(2, 3), 5));\n';

let env: TestEnv;
let dir: string;
let repo: string;
let catalog: FakeProvider;

/** OpenRouter's public catalog: where Artel learns the vendors' current models. */
const CATALOG = [
  { id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5", created: 300 },
  { id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5", created: 200 },
  { id: "anthropic/claude-opus-5.5:batch", name: "Anthropic: Claude Opus 5.5 (batch)", created: 200 },
  { id: "anthropic/claude-opus-4.8", name: "Anthropic: Claude Opus 4.8", created: 150 },
  { id: "anthropic/claude-fable-5.1", name: "Anthropic: Claude Fable 5.1", created: 100 },
  { id: "anthropic/claude-3-haiku", name: "Anthropic: Claude 3 Haiku", created: 1 },
  { id: "openai/gpt-6-sol", name: "OpenAI: GPT-6 Sol", created: 50 },
  { id: "openai/gpt-image-2", name: "OpenAI: GPT Image 2", created: 60, architecture: { output_modalities: ["image"] } },
  { id: "google/gemini-3.8-flash", name: "Google: Gemini 3.8 Flash", created: 40 },
  { id: "google/gemini-4-argon", name: "Google: Gemini 4 Argon", created: 70 },
  { id: "google/gemini-4-argon:batch", name: "Google: Gemini 4 Argon (batch)", created: 70 },
  { id: "google/gemini-3.1-pro-preview-customtools", name: "Google: Gemini 3.1 Pro Preview Custom Tools", created: 30 },
  { id: "google/gemma-4-31b-it", name: "Google: Gemma 4 31B", created: 35 },
  { id: "google/gemini-3-pro-image", name: "Google: Nano Banana Pro", created: 45, architecture: { output_modalities: ["image", "text"] } },
];

interface Turn {
  initModel?: string;
  limits?: Record<string, unknown>[];
  rateLimits?: Record<string, unknown>;
  text?: string;
  json?: unknown;
  error?: string;
  session?: string;
  files?: Record<string, string>;
  tools?: { name: string; input: Record<string, unknown>; output?: string; error?: boolean }[];
}

beforeEach(async () => {
  env = createTestEnv();
  catalog = await startFakeProvider({ models: CATALOG, authorized: () => true });
  env.setPresetUrl("openrouter", catalog.baseUrl);
  dir = mkdtempSync(join(tmpdir(), "artel-fake-cli-"));
  process.env.FAKE_CLI_DIR = dir;
  for (const [id, kind] of [["claude-code", "claude"], ["codex", "codex"], ["gemini-cli", "gemini"], ["antigravity", "agy"]] as const) {
    env.setCliCommand(id, [process.execPath, FAKE, kind]);
  }
  repo = makeRepo({ "package.json": '{ "type": "module" }\n', "math.js": MATH, "math.test.js": TEST_ADD });
});

afterEach(async () => {
  await env.closeAsync();
  await catalog.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const script = (turns: Turn[]) => writeFileSync(join(dir, "script.json"), JSON.stringify(turns));
const calls = (): { kind: string; args: string[]; prompt: string; cwd: string; proxy: string | null }[] =>
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
    expect(models.map((m: any) => m.id)).toEqual(["default", "claude-haiku-5-5", "claude-opus-5-5", "claude-opus-4-8", "claude-fable-5-1"]);
    expect(models[2]).toMatchObject({ name: "Claude Opus 5.5", priceIn: 0, priceOut: 0, tools: true });
  });

  it("names the other CLIs' models from the catalog too, text models only", async () => {
    const ids = async (preset: string) =>
      (await (await env.call("GET", `/api/providers/${await connect(preset)}/models`)).json()).map((m: any) => m.id);
    expect(await ids("codex")).toEqual(["default", "gpt-6-sol"]);
    // Seen: "Gemini 4 Argon" was missing, its name has no "pro" or "flash".
    expect(await ids("gemini-cli")).toEqual(["default", "gemini-4-argon", "gemini-3.8-flash"]);
  });

  it("falls back to the CLI's own aliases without the catalog", async () => {
    await catalog.close();
    const id = await connect("claude-code");
    const models = await (await env.call("GET", `/api/providers/${id}/models`)).json();
    expect(models.map((m: any) => m.id)).toEqual(["default", "fable", "opus", "sonnet", "haiku"]);
  });

  it("shows which model the default turned out to be", async () => {
    script([{ text: "Привет", initModel: "claude-opus-4-8[1m]" }]);
    const id = await connect("claude-code");
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "default" })).json();
    await say(chat.id, "Привет");
    const models = await (await env.call("GET", `/api/providers/${id}/models`)).json();
    expect(models[0]).toMatchObject({ id: "default", resolved: "Claude Opus 4.8" });
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

  it("asks to update the CLI or pick another model when it says so", async () => {
    script([
      { error: "API Error: 400 Claude Code 2.1.196 does not support this model; version 2.1.280 or newer is required. Run 'claude update'" },
      { error: "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models." },
    ]);
    const id = await connect("claude-code");
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "claude-opus-5-5" })).json();
    expect(await say(chat.id, "Привет")).toMatchObject({ status: "error", error: { code: "cli_update" } });
    expect(await say(chat.id, "Привет")).toMatchObject({ status: "error", error: { code: "cli_limit" } });
    expect(calls()[0]!.args).toEqual(expect.arrayContaining(["--model", "claude-opus-5-5"]));
  });

  it("shows how much of the subscription's limit is used, as the CLI reports it", async () => {
    const id = await connect("claude-code");
    expect(await (await env.call("GET", `/api/providers/${id}/limits`)).json()).toEqual([]);
    script([
      {
        text: "Привет",
        limits: [
          { status: "allowed", resetsAt: 1_800_000_000, rateLimitType: "five_hour", utilization: 0.12 },
          { status: "allowed_warning", resetsAt: 1_800_500_000, rateLimitType: "seven_day", utilization: 0.81 },
        ],
      },
    ]);
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "default" })).json();
    await say(chat.id, "Привет");
    expect(await (await env.call("GET", `/api/providers/${id}/limits`)).json()).toEqual([
      { window: "five_hour", usedShare: 0.12, resetsAt: 1_800_000_000_000, status: "ok" },
      { window: "seven_day", usedShare: 0.81, resetsAt: 1_800_500_000_000, status: "warning" },
    ]);

    // Codex reports the same in percent, with the window in minutes.
    const codex = await connect("codex");
    script([{ text: "Привет" }, { text: "Привет", rateLimits:{ primary: { used_percent: 40, window_minutes: 300, resets_at: 1_800_000_000 }, secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1_800_500_000 } } }]);
    const chat2 = await (await env.call("POST", "/api/chats", { providerId: codex, model: "default" })).json();
    await say(chat2.id, "Привет");
    expect(await (await env.call("GET", `/api/providers/${codex}/limits`)).json()).toEqual([
      { window: "five_hour", usedShare: 0.4, resetsAt: 1_800_000_000_000, status: "ok" },
      { window: "seven_day", usedShare: 1, resetsAt: 1_800_500_000_000, status: "reached" },
    ]);
  });

  it("says plainly that Google no longer serves Gemini CLI to personal accounts", async () => {
    script([{ error: "This client is no longer supported for Gemini Code Assist for individuals. Please migrate to Antigravity." }]);
    const id = await connect("gemini-cli");
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "default" })).json();
    expect(await say(chat.id, "Привет")).toMatchObject({ status: "error", error: { code: "cli_retired" } });
  });

  it("gives the CLI the proxy when its provider uses one", async () => {
    const proxy = await startFakeProxy();
    try {
      script([{ text: "Привет" }]);
      await env.call("PUT", "/api/proxy", { url: proxy.url });
      const id = await connect("claude-code");
      await env.call("PATCH", `/api/providers/${id}`, { useProxy: true });
      const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "default" })).json();
      await say(chat.id, "Привет");
      expect(calls()[0]!.proxy).toBe(proxy.url);
    } finally {
      await proxy.close();
    }
  });

  it("works with Gemini CLI too", async () => {
    script([{ text: "Привет из Gemini" }]);
    const id = await connect("gemini-cli");
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "flash" })).json();
    expect(await say(chat.id, "Привет")).toMatchObject({ status: "done", content: "Привет из Gemini" });
    expect(calls()[0]!.args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "-m", "flash", "--approval-mode", "default"]));
  });
});

describe("Antigravity CLI", () => {
  it("lists the models agy names, answers through it and continues the conversation", async () => {
    const id = await connect("antigravity");
    const models = await (await env.call("GET", `/api/providers/${id}/models`)).json();
    expect(models.map((m: any) => m.id)).toEqual(["default", "gemini-4-argon", "gemini-3.8-flash", "claude-sonnet-5-5"]);

    script([
      { text: "Привет из Antigravity", session: "conv-1", tools: [{ name: "read_file", input: { path: "README.md" } }] },
      { text: "Второй ответ", session: "conv-1" },
    ]);
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "gemini-4-argon" })).json();
    // Thinking counts as output, as agy bills it.
    expect(await say(chat.id, "Привет")).toMatchObject({ status: "done", content: "Привет из Antigravity", inputTokens: 120, outputTokens: 35, costUsd: 0 });
    expect(await say(chat.id, "Ещё")).toMatchObject({ content: "Второй ответ" });

    const [first, second] = calls();
    expect(first!.args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--input-format", "stream-json", "--model", "gemini-4-argon"]));
    // Read-only in a chat: nothing is approved on its own.
    expect(first!.args).not.toContain("--dangerously-skip-permissions");
    // The prompt goes in as agy's own input line, not as an argument.
    expect(JSON.parse(first!.prompt.trim())).toMatchObject({ event: "user", message: { content: expect.stringContaining("Привет") } });
    expect(second!.args).toEqual(expect.arrayContaining(["--conversation", "conv-1"]));
  });

  it("tells the user to sign in when agy is not signed in", async () => {
    script([{ error: "authentication required: run agy to sign in" }]);
    const id = await connect("antigravity");
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "default" })).json();
    expect(await say(chat.id, "Привет")).toMatchObject({ status: "error", error: { code: "cli_login" } });
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
