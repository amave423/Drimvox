import { slug } from "../src/work/project-git";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { storeOf } from "../src/agent/store";
import { retryWait } from "../src/work/run";
import { CHECK_STEPS } from "../src/work/check";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { git, makeRepo } from "./git-repo";

// docs/specs/project-work.md: one conversation per project, as a chat with a folder; a plan first, as Claude Code makes it.
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
const PRICED = [{ id: "coder", supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" } }];

/** A fake provider answering each model from its own queue: who wrote what shows in the requests. */
async function setup(queues: Record<string, FakeTurn[]>, models: Record<string, unknown>[] = [{ id: "coder", supported_parameters: ["tools"] }]) {
  fake = await startFakeProvider({
    key: KEY,
    models: [...models, ...Object.keys(queues).filter((id) => !models.some((m) => m.id === id)).map((id) => ({ id, supported_parameters: ["tools"] }))],
    // The code reviewer before the end answers from its own queue, "nothing found" by default.
    // The tester after an answer that changed files answers from its own queue, "nothing found" by default.
    respond: (body) =>
      isReviewer(body)
        ? (queues.reviewer?.shift() ?? call("report_review", { issues: [], summary: "Проблем нет." }))
        : isTester(body)
          ? (queues.tester?.shift() ?? call("report_check", { problems: [], summary: "Проверил, всё работает." }))
          : (queues[body.model]?.shift() ?? { text: "Готово." }),
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

/** The models a test's work goes with; go() sends the first message with them, after the limits. */
const chosen = new Map<string, { work: string; strong: string | null }>();
function prepared(s: Awaited<ReturnType<typeof setup>>, models: { work?: string; strong?: string | null } = {}) {
  chosen.set(s.project.id, { work: models.work ?? "coder", strong: models.strong ?? null });
}
async function go(s: Awaited<ReturnType<typeof setup>>, limits: { budgetUsd: number; hours: number }) {
  await env.call("PATCH", `/api/projects/${s.project.id}/work`, limits);
  const m = chosen.get(s.project.id) ?? { work: "coder", strong: null };
  const res = await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Сайт клиники", model: s.ref(m.work), strong: m.strong ? s.ref(m.strong) : null });
  expect(res.status).toBe(200);
  return res;
}

const isReviewer = (body: any) => /You are the code reviewer/.test(JSON.stringify(body.messages?.[0]?.content ?? ""));
const isTester = (body: any) => /You are the tester/.test(JSON.stringify(body.messages?.[0]?.content ?? ""));
const requestsOf = (model: string) => fake!.requests.filter((r) => r.path === "/v1/chat/completions" && r.body.model === model && !isReviewer(r.body) && !isTester(r.body));

describe("work on a project", () => {
  // Seen live: with a laptop saved in the settings, the interview asked the user twice for its address and password.
  it("tells the work of the saved SSH servers", async () => {
    expect((await env.call("POST", "/api/ssh", { name: "ноутбук", host: "192.168.1.129", user: "ml_server", auth: "key" })).status).toBe(201);
    const s = await setup({ coder: [] });
    prepared(s);
    await go(s, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status !== "running" && !!w.startedAt);
    expect(JSON.stringify(requestsOf("coder")[0]!.body.messages[0])).toContain("ноутбук (ml_server@192.168.1.129)");
    expect(JSON.stringify(requestsOf("coder").at(-1)!.body.messages[0])).toContain("Never ask the user for a server's address");
  });

  // Asked for: a cap that really stops: the budget is for one message's work.
  it("stops a message's work at its budget, whatever the project spent before", async () => {
    const big = { prompt_tokens: 1_000_000, completion_tokens: 0 };
    const s = await setup({ coder: [{ text: "Первое.", usage: big }, { ...call("list_files", { path: "." }), usage: big }, { text: "Второе." }] }, PRICED);
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("PATCH", `/api/projects/${s.project.id}/work`, { budgetUsd: 0.5 });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Первое", model: s.ref("coder") });
    // The first message spent a dollar in one step: it was over at its end.
    await until(s.project.id, (w) => w.status !== "running" && requestsOf("coder").length === 1);
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Второе", model: s.ref("coder") });
    const paused = await until(s.project.id, (w) => w.status === "paused" && requestsOf("coder").length === 2);
    expect(paused.reason).toBe("budget");
  });

  // Seen live: a long answer of DeepSeek through RouterAI broke off twice in a row, and the run stopped mid-work.
  it("goes on when a provider's answer breaks off mid-stream", async () => {
    const busy = { brokenOff: true };
    const s = await setup({ coder: [busy, busy, busy, { text: "Сделал." }] });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Сделай", model: s.ref("coder") });
    const done = await until(s.project.id, (w) => w.status !== "running" && requestsOf("coder").length >= 4);
    expect(done.status).toBe("done");
  });

  it("tries a busy, unreachable or unreadable provider five times, a refusal twice", () => {
    expect([1, 2, 3, 4, 5].map((n) => retryWait("bad_response", n))).toEqual([5_000, 15_000, 30_000, 60_000, null]);
    expect(retryWait("overloaded", 4)).toBe(60_000);
    expect([1, 2].map((n) => retryWait("provider_error", n))).toEqual([5_000, null]);
  });

  // Asked for: what reading, the cache and writing each cost, at what rate.
  it("keeps the rates the model was billed at: new input, input from the cache, output", async () => {
    const s = await setup({ coder: [{ text: "Готово." }] }, [{ id: "coder", supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" } }]);
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Привет", model: s.ref("coder") });
    const done = await until(s.project.id, (w) => w.status === "done");
    expect(done.rates).toEqual({ input: 1, cached: 0.1, output: 2 });
  });

  // The working model keeps failing: the strong one takes over, when the project has one.
  it("hands the work to the strong model when the working one keeps failing", async () => {
    const s = await setup({ coder: [{ fail: { status: 400, message: "Broken" } }, { fail: { status: 400, message: "Broken" } }], strong: [{ text: "Сделал." }] });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Сделай", model: s.ref("coder"), strong: s.ref("strong") });
    const done = await until(s.project.id, (w) => w.status === "done");
    expect(done.escalated).toBe(true);
    expect(requestsOf("strong")).toHaveLength(1);
  });

  // Seen: four MCP servers were switched on and the project's run had none of them (only the interview did).
  // Their descriptions wait until loaded, as the rare tools' do (asked for: fewer tools sent with every step).
  it("gives the run the tools of the user's MCP servers, loaded when the model asks for them", async () => {
    const server = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
    await env.call("POST", "/api/mcp", { name: "demo", command: process.execPath, args: [server], trust: "trusted" });
    const s = await setup({
      coder: [
        call("find_tools", { names: ["mcp_demo_echo"] }),
        call("mcp_demo_echo", { text: "кедр" }),
        { text: "Готово." },
        { text: "Готово." },
      ],
    });
    prepared(s);
    await go(s, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "done");
    const first = requestsOf("coder").find((r) => r.body.tools?.some((t: any) => t.function.name === "find_tools"))!.body;
    expect(first.tools.map((t: any) => t.function.name)).not.toContain("mcp_demo_echo");
    expect(JSON.stringify(first.tools)).toContain("mcp_demo_echo");
    const sent = requestsOf("coder").at(-1)!.body;
    expect(sent.tools.map((t: any) => t.function.name)).toContain("mcp_demo_echo");
    expect(JSON.stringify(sent.messages)).toContain("echo: кедр");
  });

  it("takes a message the user writes while it works into the next answer, and goes on", async () => {
    const s = await setup({
      coder: [
        { ...call("list_files", { path: "." }), delayMs: 600 },
        { text: "Готово, кнопка зелёная." },
      ],
    });
    prepared(s);
    await go(s, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "running");
    const sent = await (await env.call("POST", `/api/projects/${s.project.id}/work/message`, { content: "Сделай кнопку зелёной" })).json();
    expect(sent.queued).toBe(true);
    await until(s.project.id, (w) => w.status === "done");
    const later = requestsOf("coder").slice(1);
    expect(later.some((r) => JSON.stringify(r.body.messages).includes("Сделай кнопку зелёной"))).toBe(true);
    const chat = await (await env.call("GET", `/api/chats/${sent.chatId}`)).json();
    expect(chat.messages.filter((m: any) => m.role === "user").map((m: any) => m.content)).toContain("Сделай кнопку зелёной");
  });

  // Seen live: "0 min, 0 ₽" for minutes in the panel, as time and money were counted only when an answer of many steps ended.
  it("counts the time and the money of the answer going on now", async () => {
    const s = await setup(
      {
        coder: [
          { ...call("list_files", { path: "." }), usage: { prompt_tokens: 100_000, completion_tokens: 1000 } },
          { ...call("list_files", { path: "." }), delayMs: 1500 },
          { text: "Готово." },
        ],
      },
      PRICED,
    );
    prepared(s);
    await go(s, { budgetUsd: 5, hours: 2 });
    const during = await until(s.project.id, (w) => w.status === "running" && w.spentUsd > 0.05);
    expect(during.workedMs).toBeGreaterThan(0);
    expect(during.spentUsd).toBeCloseTo(0.102, 3);
    const done = await until(s.project.id, (w) => w.status === "done");
    expect(done.spentUsd).toBeGreaterThanOrEqual(during.spentUsd);
    expect(done.spentUsd).toBeLessThan(during.spentUsd + 0.01);
  });

  it("stops when the budget runs out, and goes on once it is raised", async () => {
    const big = { prompt_tokens: 1_000_000, completion_tokens: 0 };
    const s = await setup(
      {
        coder: [
          { ...call("list_files", { path: "." }), usage: big },
          { text: "Готово." },
        ],
      },
      PRICED,
    );
    prepared(s);
    await go(s, { budgetUsd: 0.5, hours: 2 });
    const paused = await until(s.project.id, (w) => w.status === "paused");
    expect(paused).toMatchObject({ reason: "budget" });
    expect(paused.spentUsd).toBeGreaterThanOrEqual(0.5);
    await env.call("PATCH", `/api/projects/${s.project.id}/work`, { budgetUsd: 5 });
    expect((await env.call("POST", `/api/projects/${s.project.id}/work/continue`)).status).toBe(200);
    expect(await until(s.project.id, (w) => w.status === "done")).toMatchObject({ budgetUsd: 5 });
  });

  // Seen live: after "Go" the agent wrote in English until the user asked in Russian.
  it("tells the working model to write in the user's language", async () => {
    const s = await setup({ coder: [{ text: "Готово." }] });
    prepared(s);
    await go(s, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "done");
    expect(JSON.stringify(requestsOf("coder").at(-1)!.body.messages[0])).toMatch(/language the user writes in/);
  });

  // The workspace's "Changes": what the agent did to the folder since the last commit, new files too, index untouched.
  it("shows the folder's changes since the last commit", async () => {
    const s = await setup({ coder: [] });
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

  it("offers the project's skills in the run, and the agent can open one", async () => {
    mkdirSync(join(folder, ".drimvox", "skills", "style"), { recursive: true });
    writeFileSync(join(folder, ".drimvox", "skills", "style", "SKILL.md"), ["---", "name: style", "description: When making pages for this site", "---", "Use the brand green.", ""].join("\n"));
    const s = await setup({
      coder: [call("use_skill", { name: "style" }), { text: "Готово." }],
    });
    prepared(s);
    await go(s, { budgetUsd: 1, hours: 2 });
    await until(s.project.id, (w) => w.status === "done");
    const run = requestsOf("coder");
    expect(JSON.stringify(run[0]!.body.messages[0])).toContain("style: When making pages for this site");
    expect(JSON.stringify(run[1]!.body.messages)).toContain("Use the brand green.");
  });

  it("is done by Claude Code itself in the project's folder when the working model is on a subscription", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drimvox-fake-cli-"));
    process.env.FAKE_CLI_DIR = dir;
    writeFileSync(join(dir, "script.json"), JSON.stringify([{ text: "Сделал калькулятор.", files: { "calculator.html": "<form></form>\n" } }]));
    env.setCliCommand("claude-code", [process.execPath, fileURLToPath(new URL("./fake-cli.mjs", import.meta.url)), "claude"]);
    const s = await setup({ coder: [] });
    const cli = await (await env.call("POST", "/api/providers", { preset: "claude-code" })).json();
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Сайт клиники", model: { providerId: cli.id, model: "default" } });
    await until(s.project.id, (w) => w.status === "done");
    expect(readFileSync(join(folder, "calculator.html"), "utf8")).toBe("<form></form>\n");
    rmSync(dir, { recursive: true, force: true });
  });
});

// Asked for: a project works like the chat with a folder: each message is a turn, no checklist.
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

  // Asked for: no interview and plan switches; the agent asks when it must, as OpenCode does, with answers to pick.
  it("waits on the agent's question, takes the picked answer or a written message, and goes on", async () => {
    const question = { question: "Голос через сервер или напрямую?", header: "Голос", options: [{ label: "Напрямую (P2P)" }, { label: "Через сервер" }] };
    const s = await setup({
      coder: [call("question", { questions: [question] }), call("question", { questions: [question] }), { text: "Делаю P2P." }],
    });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Сделай голосовой чат", model: s.ref("coder") });
    const waiting = async () => {
      for (let i = 0; i < 100; i++) {
        const chat = await (await env.call("GET", `/api/chats/${(await (await env.call("GET", `/api/projects/${s.project.id}/work`)).json()).chatId}`)).json();
        if (chat.questions?.length) return chat;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("no question");
    };
    const chat = await waiting();
    expect(chat.questions[0].questions[0]).toMatchObject({ question: "Голос через сервер или напрямую?", options: [{ label: "Напрямую (P2P)" }, { label: "Через сервер" }] });
    expect((await (await env.call("GET", `/api/projects/${s.project.id}/work`)).json()).waitingApproval).toBe(true);
    const picked = await env.call("POST", `/api/chats/${chat.id}/questions/${chat.questions[0].id}`, { answers: ["Напрямую (P2P)"] });
    expect(picked.status).toBe(200);
    // The second question is answered with a message written in the box.
    await waiting();
    await env.call("POST", `/api/projects/${s.project.id}/work/message`, { content: "Через сервер, но потом" });
    await until(s.project.id, (w) => w.status === "done");
    const sent = JSON.stringify(requestsOf("coder").at(-1)!.body.messages);
    expect(sent).toContain("Голос через сервер или напрямую? → Напрямую (P2P)");
    expect(sent).toContain("Голос через сервер или напрямую? → Через сервер, но потом");
  });

  it("answers the first message at once, ends as a chat does and goes on with the next message", async () => {
    const s = await setup({
      coder: [
        { text: "Нашёл и поправил: сумма считается заново." },
        { text: "Это главная страница." },
      ],
    });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    const res = await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Почини сумму", model: s.ref("coder") });
    expect(res.status).toBe(200);
    let work = await until(s.project.id, (w) => w.status === "done");
    // No reminders to finish: it answered and stopped, as in a chat.
    expect(requestsOf("coder")).toHaveLength(1);
    expect(JSON.stringify(requestsOf("coder")[0]!.body.messages[0])).toContain("Drimvox's coding agent");
    const chat = await (await env.call("GET", `/api/chats/${work.chatId}`)).json();
    expect(chat.messages.map((m: any) => m.content)).toEqual(["Почини сумму", "Нашёл и поправил: сумма считается заново."]);

    // Written to once, the project's kind stays (asked for).
    expect((await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "new" })).status).toBe(409);
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "А это что?", model: s.ref("coder") });
    work = await until(s.project.id, (w) => w.status === "done" && requestsOf("coder").length === 2);
    const again = await (await env.call("GET", `/api/chats/${work.chatId}`)).json();
    expect(again.messages.at(-1).content).toBe("Это главная страница.");
  });

  // Seen live: the agent started the same server three times, as each answer's end stopped it.
  it("keeps a server the agent started running between the user's messages", async () => {
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
    // The agent's answer, not the tester's after it.
    const acts = chat.messages.find((m: any) => m.activity?.some((a: any) => a.name === "write_file")).activity.map(({ at: _at, ...a }: any) => a);
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
    // The fourth: after the tester found nothing, the word to publish what was held back.
    expect(requestsOf("coder")).toHaveLength(4);
    expect(JSON.stringify(requestsOf("coder")[1]!.body.messages)).toContain("cut off by the output limit");
    expect(JSON.stringify(requestsOf("coder")[3]!.body.messages)).toContain("found nothing");
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

  // Asked for: the agent commits itself with messages of its own, as in OpenCode; Drimvox's commits were named by the
  // user's messages. Drimvox makes none of its own.
  it("leaves the commits to the agent, with its own messages, in the project's branch", async () => {
    const s = await ready([
      call("write_file", { path: "cart.js", content: "total()\n" }),
      call("write_file", { path: ".env", content: "KEY=secret\n" }),
      call("run_command", { command: 'git add cart.js; git -c user.name=t -c user.email=t@t commit -q -m "Fix cart total"' }),
      { text: "Готово." },
    ]);
    await ask(s, "Почини корзину", 4);
    expect(git(folder, "branch", "--show-current")).toBe("main");
    expect(git(folder, "log", "--format=%s", "-1")).toBe("Fix cart total");
    // Only the work: the project's state is kept in Drimvox's data, not in the project (asked for).
    expect(git(folder, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["cart.js"]);
    expect(existsSync(join(folder, "AGENTS.md"))).toBe(false);
    const state = readFileSync(join(storeOf(folder), "state.md"), "utf8");
    expect(state).toContain("Goal: Почини корзину");
    expect(state).toContain("Git branch: main");
    expect(git(folder, "status", "--porcelain")).toBe("?? .env");
    expect(JSON.stringify(requestsOf("coder")[0]!.body.tools ?? []).includes("commit_changes")).toBe(false);
    const view = await (await env.call("GET", `/api/projects/${s.project.id}/git`)).json();
    expect(view.state).toMatchObject({ branch: "main", base: null, github: false, pullRequest: null });
  });

  // Asked for: no AGENTS.md, .drimvox or pointer files of Drimvox's in the project; the notes are kept in its data.
  it("leaves nothing of its own in the project's folder: notes, state and long outputs are kept in Drimvox's data", async () => {
    const long = `node -e "for (let i = 1; i <= 3000; i++) console.log('line ' + i)"`;
    const s = await ready([call("update_notes", { notes: "Сборка: npm run build" }), call("run_command", { command: long, timeout_seconds: 60 }), { text: "Готово." }]);
    await ask(s, "Запиши заметки", 3);
    expect(existsSync(join(folder, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(folder, ".drimvox"))).toBe(false);
    expect(git(folder, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(storeOf(folder), "notes.md"), "utf8")).toContain("npm run build");
  });

  // Seen live: a project left on "drimvox/task-1106-2048 → master" from before, which said nothing to its user.
  it("brings an agent's branch left from before back into the branch it came from, and works there", async () => {
    const s = await ready([
      call("write_file", { path: "b.txt", content: "b\n" }),
      call("run_command", { command: 'git add b.txt; git -c user.name=t -c user.email=t@t commit -q -m "Add b"' }),
      { text: "Готово." },
    ]);
    git(folder, "switch", "-q", "-c", "drimvox/task-1106-2048");
    writeFileSync(join(folder, "a.txt"), "a\n");
    git(folder, "add", "a.txt");
    git(folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a");
    env.db.sql
      .prepare("insert into settings (key, value) values (?, ?)")
      .run(`git.branch:${s.project.id}`, JSON.stringify({ branch: "drimvox/task-1106-2048", base: "main", pullRequest: null }));
    await ask(s, "Сделай b", 3);
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

  // The project's git card says when to commit and how the messages read: the agent, who commits now, is told so.
  it("tells the agent the project's rules for its commits: when, and in which language", async () => {
    const s = await ready([{ text: "Готово." }], { commit: "end", messages: "ru" });
    await ask(s, "Сделай a", 1);
    const system = JSON.stringify(requestsOf("coder")[0]!.body.messages[0]);
    expect(system).toContain("Commit your work with git yourself, once, when the whole task is done and checked");
    expect(system).toContain("in Russian");
    expect(system).toContain("Never delete a repository");
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

// Asked for: the cheaper model for sub-agents is the project's own choice, in its parameters.
describe("a project's service model", () => {
  it("does the sub-agents' research instead of the working model", async () => {
    const isSub = (body: any) => JSON.stringify(body.messages?.[0] ?? "").includes("You are a sub-agent");
    const s = await setup({
      coder: [call("delegate", { description: "Найти заголовок", prompt: "Что написано в index.html?" }), { text: "Там «Клиника»." }],
      cheap: [call("report", { report: "В index.html заголовок «Клиника»." })],
    });
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    expect((await env.call("PUT", `/api/projects/${s.project.id}/extensions`, { service: s.ref("cheap") })).status).toBe(200);
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Что за заголовок?", model: s.ref("coder") });
    await until(s.project.id, (w) => w.status === "done");
    const asks = fake!.requests.filter((r) => r.path === "/v1/chat/completions");
    expect(asks.some((r) => r.body.model === "cheap" && isSub(r.body))).toBe(true);
    expect(asks.some((r) => r.body.model === "coder" && isSub(r.body))).toBe(false);
  });
});

// Asked for: "why do I find the bugs". After an answer that changed files a tester tries the work as the user will; what
// it finds goes back to the agent, at most twice in a turn.
describe("the tester", () => {
  const testerAsks = () => fake!.requests.filter((r) => r.path === "/v1/chat/completions" && isTester(r.body));
  const found = (what: string) => call("report_check", { problems: [{ what, steps: "Открыть страницу", severity: "broken" }], summary: "Открыл страницу." });
  async function open(queues: Record<string, FakeTurn[]>, check?: boolean) {
    const s = await setup(queues);
    await env.call("PATCH", `/api/projects/${s.project.id}`, { kind: "existing" });
    if (check !== undefined) await env.call("PUT", `/api/projects/${s.project.id}/extensions`, { check });
    await env.call("POST", `/api/projects/${s.project.id}/work/chat`, { content: "Сделай кнопку записи", model: s.ref("coder") });
    return until(s.project.id, (w) => w.status !== "running");
  }

  it("tries the changed work, sends what it found back to the agent, and checks again after the fix", async () => {
    const work = await open({
      coder: [call("write_file", { path: "index.html", content: "<button>Запись</button>\n" }), { text: "Готово." }, call("edit_file", { edits: [{ path: "index.html", old: "Запись", new: "Записаться" }] }), { text: "Исправил." }],
      tester: [found("Кнопка называется «Запись», а не «Записаться»")],
    });
    expect(work.status).toBe("done");
    expect(readFileSync(join(folder, "index.html"), "utf8")).toBe("<button>Записаться</button>\n");
    // The agent got the findings as the next message, and the tester came again after the fix.
    expect(JSON.stringify(requestsOf("coder")[2]!.body.messages)).toContain("Кнопка называется «Запись»");
    expect(testerAsks().length).toBe(2);
    // Clean the second time: the agent is told so, and that a release or a deploy it held back goes out now.
    expect(JSON.stringify(requestsOf("coder").at(-1)!.body.messages)).toContain("found nothing");
    expect(JSON.stringify(requestsOf("coder")[0]!.body.messages[0])).toContain("Publish nothing in a reply that changed files");
    // The tester sees the request and the agent's words, and cannot change the project's files.
    const first = JSON.stringify(testerAsks()[0]!.body.messages);
    expect(first).toContain("Сделай кнопку записи");
    expect(first).toContain("Готово.");
    const tools = testerAsks()[0]!.body.tools.map((t: any) => t.function.name);
    expect(tools).toContain("run_command");
    expect(tools).toContain("report_check");
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("edit_file");
    // Its report is in the conversation for the user.
    const chat = await (await env.call("GET", `/api/chats/${work.chatId}`)).json();
    expect(chat.messages.some((m: any) => m.role === "assistant" && m.content.includes("Кнопка называется «Запись»"))).toBe(true);
  });

  it("does not come after an answer that changed nothing, nor when the project switched it off", async () => {
    await open({ coder: [{ text: "Это кнопка записи в index.html." }] });
    expect(testerAsks()).toHaveLength(0);
    await fake!.close();
    fake = undefined;
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    folder = makeRepo({ "index.html": "<h1>Клиника</h1>\n" });
    await open({ coder: [call("write_file", { path: "index.html", content: "<button>Запись</button>\n" }), { text: "Готово." }] }, false);
    expect(testerAsks()).toHaveLength(0);
  });

  // Seen live: 61 steps of real testing and no report, all of it lost.
  it("is told to wrap up near its last step, and out of steps gives its report all the same", async () => {
    const work = await open({
      coder: [call("write_file", { path: "index.html", content: "<button>Запись</button>\n" }), { text: "Готово." }, { text: "Исправил." }],
      tester: [...Array.from({ length: CHECK_STEPS }, () => call("list_files", { path: "." })), found("Кнопка не нажимается")],
    });
    expect(work.status).toBe("done");
    expect(JSON.stringify(testerAsks().at(-2)!.body.messages)).toContain("steps left: stop what you are trying and call report_check");
    // The last step could only report, and the agent got what it found.
    expect(testerAsks().at(-1)!.body.tools.map((t: any) => t.function.name)).toEqual(["report_check"]);
    expect(JSON.stringify(requestsOf("coder").at(-1)!.body.messages)).toContain("Кнопка не нажимается");
  });

  it("stops after two rounds, whatever it still finds", async () => {
    const write = (n: number) => call("write_file", { path: "index.html", content: `<button>${n}</button>\n` });
    const work = await open({
      coder: [write(1), { text: "Готово." }, write(2), { text: "Исправил." }, write(3), { text: "Исправил ещё." }],
      tester: [found("Не то"), found("Всё ещё не то"), found("Опять не то")],
    });
    expect(work.status).toBe("done");
    expect(testerAsks()).toHaveLength(2);
  });
});
