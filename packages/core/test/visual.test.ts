import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { makeRepo } from "./git-repo";
import { waitWork } from "./project-run";

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

/** A project's agent follows its script; the vision model "eyes" answers from its own list. Returns the project's id. */
async function start(coder: FakeTurn[], eyes: string[], o: { visionSetting?: boolean } = {}) {
  const coderQueue = [...coder];
  const eyesQueue = [...eyes];
  fake = await startFakeProvider({
    key: KEY,
    models: [
      { id: "coder", supported_parameters: ["tools"], architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      // Without the setting no model of the provider sees: Drimvox would otherwise find this one by itself.
      { id: "eyes", architecture: { input_modalities: o.visionSetting === false ? ["text"] : ["text", "image"], output_modalities: ["text"] } },
    ],
    respond: (body) => (body.model === "eyes" ? { text: eyesQueue.shift() ?? "PASS" } : (coderQueue.shift() ?? { text: "Готово." })),
  });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  if (o.visionSetting !== false) await env.call("PATCH", "/api/settings", { visionModel: { providerId: provider.id, model: "eyes" } });
  const project = await (await env.call("POST", "/api/projects", { path: repo, kind: "existing" })).json();
  await env.call("POST", `/api/projects/${project.id}/work/chat`, { content: "Сделай страницу", model: { providerId: provider.id, model: "coder" } });
  return project.id as string;
}

const settle = (projectId: string) => waitWork(env, projectId);
/** What each call of a tool gave back, as the agent got it in its last request. */
function results(name: string): string[] {
  const messages = fake!.requests.filter((r) => r.path === "/v1/chat/completions" && r.body.model === "coder").at(-1)!.body.messages as any[];
  const named = new Map<string, string>(messages.flatMap((m) => (m.tool_calls ?? []).map((c: any) => [c.id, c.function.name] as [string, string])));
  return messages.filter((m) => m.role === "tool" && named.get(m.tool_call_id) === name).map((m) => String(m.content));
}
const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });
const visionRequests = () => fake!.requests.filter((r) => r.path === "/v1/chat/completions" && r.body.model === "eyes");

describe("look_at_page", () => {
  it("photographs a local page and returns what the vision model sees", async () => {
    const id = await start([call("look_at_page", { url: "http://localhost:5173/", question: "Виден заголовок Привет?" })], ["Да, заголовок «Привет» по центру."]);
    const work = await settle(id);
    expect(shots).toEqual(["http://localhost:5173/"]);

    const asked = JSON.stringify(visionRequests()[0]!.body.messages);
    expect(asked).toContain("Виден заголовок Привет?");
    expect(asked).toContain("data:image/png;base64,");

    expect(results("look_at_page")[0]).toContain("заголовок «Привет» по центру");
    const shot = work.shots[0];
    expect(shot).toMatchObject({ url: "http://localhost:5173/" });
    const file = await env.call("GET", `/api/projects/${id}/work/shots/${shot.id}`);
    expect(file.headers.get("content-type")).toBe("image/png");
  });

  // Seen live: an agent wrote three diagnostic pages to learn why its page stayed empty; a failed script does not show.
  it("hands the page's console errors to the agent with what the vision model sees", async () => {
    env.setScreenshot(async () => ({ png: PNG, console: ["Uncaught SyntaxError: Unexpected token '}' (ui.js:120)"] }));
    const id = await start([call("look_at_page", { url: "http://localhost:5173/", question: "Видно небо?" })], ["Страница пустая."]);
    await settle(id);
    const [output] = results("look_at_page");
    expect(output).toContain("Страница пустая.");
    expect(output).toContain("Errors in the page's console:\n- Uncaught SyntaxError: Unexpected token '}' (ui.js:120)");
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
      ],
      ["Да, в корзине одна доска."],
    );
    await settle(id);
    expect(steps[0]).toEqual(scenario);
    const outputs = results("look_at_page");
    expect(outputs[0]).toContain("одна доска");
    expect(outputs[1]).toMatch(/not found on the page: Нет такой/);
  });

  // Seen live: an agent told to care about the look kept photographing its page, a dozen times and $0.80 later.
  it("lets an agent look a few times per answer, then tells it to go on with the work", async () => {
    const look = call("look_at_page", { url: "http://localhost:5173/", question: "Как выглядит?" });
    const id = await start(Array.from({ length: 9 }, () => look), []);
    await settle(id);
    expect(shots).toHaveLength(8);
    expect(results("look_at_page").at(-1)).toMatch(/looked at pages enough in this answer/);
  });

  // Seen live: a requirement asked for the phone layout and the acceptance agent had no way to look at it.
  it("photographs a page at the width asked for, a desktop one by default", async () => {
    const id = await start([
      call("look_at_page", { url: "http://localhost:5173/", question: "Как на телефоне?", width: 390 }),
      call("look_at_page", { url: "http://localhost:5173/", question: "А на компьютере?" }),
    ], []);
    await settle(id);
    expect(widths).toEqual([390, 1280]);
  });

  // Seen live: a weather site was checked with 8 openings, 13 looks and 29 scripts in the page, a model request each.
  it("checks a page in one call: a desktop and a phone screenshot in one question, and the console's errors", async () => {
    env.setScreenshot(async (_url, size) => (widths.push(size.width), { png: PNG, console: ["Uncaught TypeError: x is undefined (app.js:3)"] }));
    const id = await start([call("check_page", { url: "http://localhost:5173/", focus: "Метеограмма" })], ["Компьютер: всё на месте. Телефон: таблица вылезает за край."]);
    await settle(id);
    expect(widths).toEqual([1280, 390]);
    expect(visionRequests()).toHaveLength(1);
    const asked = JSON.stringify(visionRequests()[0]!.body.messages);
    expect(asked.match(/data:image\/png;base64,/g)).toHaveLength(2);
    expect(asked).toContain("Метеограмма");
    const [output] = results("check_page");
    expect(output).toContain("таблица вылезает за край");
    expect(output).toContain("- Uncaught TypeError: x is undefined (app.js:3)");
  });

  // Seen live: told to check twice at most, the agent checked five times, tweaking details between.
  it("lets an agent check a page twice per answer, then tells it to stop", async () => {
    const check = call("check_page", { url: "http://localhost:5173/" });
    const id = await start([check, check, check], ["Всё на месте.", "Всё на месте."]);
    await settle(id);
    const outputs = results("check_page");
    expect(outputs.slice(0, 2)).toEqual([expect.stringContaining("Всё на месте."), expect.stringContaining("Всё на месте.")]);
    expect(outputs.at(-1)).toMatch(/give the user your short reply/);
  });

  it("opens only this computer and the public internet", async () => {
    const id = await start([call("look_at_page", { url: "http://192.168.1.10/admin", question: "?" })], []);
    await settle(id);
    expect(shots).toEqual([]);
    expect(results("look_at_page")[0]).toMatch(/Error|not allowed|only/i);
  });

  it("has no look_at_page without a model that sees pictures", async () => {
    await settle(await start([], [], { visionSetting: false }));
    const tools = fake!.requests.find((r) => r.path === "/v1/chat/completions")!.body.tools.map((t: any) => t.function.name);
    expect(tools).not.toContain("look_at_page");
    expect(tools).toContain("start_background");
  });
});

describe("background processes", () => {
  // In a ready project the agent's server stays between messages (seen live: it started the same server three times
  // over); the window lists it with its project and stops it.
  it("starts a server, shows its output and keeps it for the next message, until the user stops it", async () => {
    const server = `node -e "console.log('ready on 4321'); setInterval(() => {}, 1000)"`;
    const id = await start([call("start_background", { command: server }), call("read_background", { id: 1 })], []);
    await settle(id);
    const [started] = results("start_background");
    expect(started).toMatch(/Started process 1/);
    expect(results("read_background")[0]).toContain("ready on 4321");
    const pid = Number(started!.match(/pid (\d+)/)![1]);
    const [listed] = await (await env.call("GET", "/api/processes")).json();
    expect(listed.owner).toMatchObject({ kind: "project", projectId: id });
    expect((await env.call("POST", "/api/processes/stop", { key: listed.key, id: listed.id })).status).toBe(200);
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
