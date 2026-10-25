import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { makeRepo } from "./git-repo";

const KEY = "good-key";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let env: TestEnv;
let fake: FakeProvider | undefined;
let repo: string;
const shots: string[] = [];
const widths: number[] = [];
const steps: unknown[] = [];

beforeEach(() => {
  env = createTestEnv();
  shots.length = 0;
  widths.length = 0;
  steps.length = 0;
  env.setScreenshot(async (url, size, actions) => {
    shots.push(url);
    widths.push(size.width);
    steps.push(actions ?? null);
    if (actions?.some((a) => a.target === "Нет такой")) throw new Error("Step 1: not found on the page: Нет такой");
    return PNG;
  });
  repo = makeRepo({ "index.html": "<h1>Привет</h1>\n" });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The coder follows its script; the vision model "eyes" answers from its own list. */
async function start(coder: FakeTurn[], eyes: string[], o: { spec?: boolean; visionSetting?: boolean; acceptor?: FakeTurn[] } = {}) {
  const coderQueue = [...coder];
  const eyesQueue = [...eyes];
  const acceptorQueue = [...(o.acceptor ?? [])];
  const isAcceptor = (body: any) => /acceptance agent/i.test(JSON.stringify(body.messages?.[0]?.content ?? ""));
  fake = await startFakeProvider({
    key: KEY,
    models: [
      { id: "coder", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      { id: "eyes", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
    ],
    respond: (body) =>
      body.model === "eyes"
        ? { text: eyesQueue.shift() ?? "PASS" }
        : ((isAcceptor(body) ? acceptorQueue.shift() : coderQueue.shift()) ?? { text: "Done." }),
  });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  if (o.visionSetting !== false) await env.call("PATCH", "/api/settings", { visionModel: { providerId: provider.id, model: "eyes" } });
  const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
  const stages = { interview: false, spec: !!o.spec, approveSpec: false, testsFirst: false };
  const task = await (await env.call("POST", `/api/projects/${project.id}/tasks`, { task: "Сделай страницу", providerId: provider.id, model: "coder", stages })).json();
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
const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });
const finish = call("finish", { summary: "Готово", commit_message: "Page" });
const visionRequests = () => fake!.requests.filter((r) => r.path === "/v1/chat/completions" && r.body.model === "eyes");

describe("look_at_page", () => {
  it("photographs a local page and returns what the vision model sees", async () => {
    const id = await start([call("look_at_page", { url: "http://localhost:5173/", question: "Виден заголовок Привет?" }), finish], ["Да, заголовок «Привет» по центру."]);
    await waitTask(id, (t) => t.status === "done_empty");
    expect(shots).toEqual(["http://localhost:5173/"]);

    const asked = JSON.stringify(visionRequests()[0]!.body.messages);
    expect(asked).toContain("Виден заголовок Привет?");
    expect(asked).toContain("data:image/png;base64,");

    const result = (await events(id)).find((e) => e.kind === "tool_result" && e.data.name === "look_at_page");
    expect(result.data, JSON.stringify(result.data)).toMatchObject({ ok: true });
    expect(result.data.output).toContain("заголовок «Привет» по центру");
    const shot = (await events(id)).find((e) => e.kind === "screenshot");
    expect(shot.data).toMatchObject({ url: "http://localhost:5173/" });
    const file = await env.call("GET", `/api/tasks/${id}/screenshots/${shot.data.id}`);
    expect(file.headers.get("content-type")).toBe("image/png");
  });

  // Seen live: an agent wrote three diagnostic pages to learn why its page stayed empty; a failed script does not show.
  it("hands the page's console errors to the agent with what the vision model sees", async () => {
    env.setScreenshot(async () => ({ png: PNG, console: ["Uncaught SyntaxError: Unexpected token '}' (ui.js:120)"] }));
    const id = await start([call("look_at_page", { url: "http://localhost:5173/", question: "Видно небо?" }), finish], ["Страница пустая."]);
    await waitTask(id, (t) => t.status === "done_empty");
    const result = (await events(id)).find((e) => e.kind === "tool_result" && e.data.name === "look_at_page");
    expect(result.data.output).toContain("Страница пустая.");
    expect(result.data.output).toContain("Errors in the page's console:\n- Uncaught SyntaxError: Unexpected token '}' (ui.js:120)");
  });

  // docs/specs/project-work.md: the agent goes through a scenario as a person would, then looks at the result.
  it("goes through the steps of a scenario before the screenshot, and says which step failed", async () => {
    const scenario = [
      { action: "type", target: "Длина, м", text: "6" },
      { action: "click", target: "В корзину" },
      { action: "wait", ms: 500 },
    ];
    const id = await start(
      [
        call("look_at_page", { url: "http://localhost:5173/", question: "В корзине 1 товар?", steps: scenario }),
        call("look_at_page", { url: "http://localhost:5173/", question: "?", steps: [{ action: "click", target: "Нет такой" }] }),
        finish,
      ],
      ["Да, в корзине одна доска."],
    );
    await waitTask(id, (t) => t.status === "done_empty");
    expect(steps[0]).toEqual(scenario);
    const results = (await events(id)).filter((e) => e.kind === "tool_result" && e.data.name === "look_at_page");
    expect(results.map((r) => r.data.ok)).toEqual([true, false]);
    expect(results[1].data.output).toMatch(/not found on the page: Нет такой/);
  });

  // Seen live: an agent told to care about the look kept photographing its page, a dozen times and $0.80 later.
  it("lets an agent look a few times per turn, then tells it to finish", async () => {
    const look = call("look_at_page", { url: "http://localhost:5173/", question: "Как выглядит?" });
    const id = await start([look, look, look, look, look, finish], []);
    await waitTask(id, (t) => t.status === "done_empty");
    expect(shots).toHaveLength(4);
    const results = (await events(id)).filter((e) => e.kind === "tool_result" && e.data.name === "look_at_page");
    expect(results.map((r) => r.data.ok)).toEqual([true, true, true, true, false]);
    expect(results.at(-1).data.output).toMatch(/design review/);
  });

  // Seen live: a requirement asked for the phone layout and the acceptance agent had no way to look at it.
  it("photographs a page at the width asked for, a desktop one by default", async () => {
    const id = await start([
      call("look_at_page", { url: "http://localhost:5173/", question: "Как на телефоне?", width: 390 }),
      call("look_at_page", { url: "http://localhost:5173/", question: "А на компьютере?" }),
      finish,
    ], []);
    await waitTask(id, (t) => t.status === "done_empty");
    expect(widths).toEqual([390, 1280]);
  });

  // Seen live: checking fourteen requirements, the acceptance agent ran out of the coder's four looks.
  it("lets the acceptance agent look more than the coder", async () => {
    const look = call("look_at_page", { url: "http://localhost:5173/", question: "Что видно?" });
    const report = call("report_acceptance", { results: [{ id: "R1", status: "done", evidence: "видно", problem: "" }], summary: "Принято" });
    const spec = call("propose_spec", {
      spec: "# Страница",
      checks: [],
      plan: ["Страница"],
      requirements: [{ id: "R1", text: "Есть заголовок", verify: "review", how: "главная" }],
    });
    const id = await start([spec, finish], [], { spec: true, acceptor: [look, look, look, look, look, look, report] });
    await waitTask(id, (t) => !["running", "queued"].includes(t.status));
    const results = (await events(id)).filter((e) => e.kind === "tool_result" && e.data.name === "look_at_page");
    expect(results.map((r) => r.data.ok)).toEqual([true, true, true, true, true, true]);
  });

  it("opens only this computer and the public internet", async () => {
    const id = await start([call("look_at_page", { url: "http://192.168.1.10/admin", question: "?" }), finish], []);
    await waitTask(id, (t) => t.status === "done_empty");
    expect(shots).toEqual([]);
    const result = (await events(id)).find((e) => e.kind === "tool_result" && e.data.name === "look_at_page");
    expect(result.data.ok).toBe(false);
  });

  it("has no look_at_page without a model that sees pictures", async () => {
    await start([finish], [], { visionSetting: false });
    for (let i = 0; i < 100 && !fake!.requests.some((r) => r.path === "/v1/chat/completions"); i++) await new Promise((r) => setTimeout(r, 20));
    const tools = fake!.requests.find((r) => r.path === "/v1/chat/completions")!.body.tools.map((t: any) => t.function.name);
    expect(tools).not.toContain("look_at_page");
    expect(tools).toContain("start_background");
  });
});

describe("background processes", () => {
  it("starts a server, shows its output and stops it when the task ends", async () => {
    const server = `node -e "console.log('ready on 4321'); setInterval(() => {}, 1000)"`;
    const id = await start([call("start_background", { command: server }), call("read_background", { id: 1 }), finish], []);
    await waitTask(id, (t) => t.status === "done_empty");
    const results = (await events(id)).filter((e) => e.kind === "tool_result");
    expect(results[0].data.output).toMatch(/Started process 1/);
    expect(results[1].data.output).toContain("ready on 4321");
    const pid = Number(results[0].data.output.match(/pid (\d+)/)![1]);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});

describe("visual checks from the spec", () => {
  const spec = (visual: unknown[]) =>
    call("propose_spec", { spec: "# Страница", checks: [], plan: ["Сверстать"], visual_checks: visual });
  const page = { url: "http://localhost:5173/", expect: "Крупный заголовок «Привет»" };

  // Seen live: one page passed and failed by turns on a language switch the screenshot did not show.
  it("asks the model to judge the substance, not what a still screenshot cannot show", async () => {
    const id = await start([call("propose_spec", { spec: "# Страница", checks: [], plan: ["Страница"], visual_checks: [{ url: "http://localhost:5173/", expect: "Заголовок Привет" }] }), finish], ["PASS: заголовок есть"], { spec: true });
    await waitTask(id, (t) => !["running", "queued"].includes(t.status));
    const asked = JSON.stringify(visionRequests()[0]!.body.messages);
    expect(asked).toMatch(/substance/);
    expect(asked).toMatch(/cannot show/);
  });

  it("checks the page after the code and sends a failure back once", async () => {
    const id = await start([spec([page]), call("write_file", { path: "index.html", content: "<h1>Привет</h1>" }), finish, finish], [
      "FAIL: заголовка не видно, белая страница.",
      "PASS: заголовок «Привет» крупный.",
    ], { spec: true });
    const done = await waitTask(id, (t) => t.status === "review");
    expect(done.visualChecks).toEqual([page]);
    const visual = (await events(id)).filter((e) => e.kind === "check" && e.data.phase === "visual").map((e) => e.data.ok);
    expect(visual).toEqual([false, true]);
    const coderMessages = JSON.stringify(fake!.requests.filter((r) => r.body?.model === "coder").at(-1)!.body.messages);
    expect(coderMessages).toContain("заголовка не видно");
  });

  it("waits for the user after two failed looks", async () => {
    const id = await start([spec([page]), finish, finish, finish], ["FAIL: пусто.", "FAIL: всё ещё пусто."], { spec: true });
    const waiting = await waitTask(id, (t) => t.status === "waiting");
    expect(waiting.statusReason).toBe("visual_failed");
  });

  it("skips visual checks it cannot do and says so", async () => {
    const id = await start([spec([page]), finish], [], { spec: true, visionSetting: false });
    await waitTask(id, (t) => t.status === "done_empty" || t.status === "review");
    const notes = (await events(id)).filter((e) => e.kind === "text").map((e) => e.data.text);
    expect(notes.join(" ")).toMatch(/visual checks/i);
  });
});
