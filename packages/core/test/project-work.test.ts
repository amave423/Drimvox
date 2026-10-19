import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { git, makeRepo } from "./git-repo";

// docs/specs/project-work.md: a task of the list is a conversation in the project's folder, like Claude Code.
const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider | undefined;
let folder: string;

beforeEach(() => {
  env = createTestEnv();
  folder = makeRepo({ "index.html": "<h1>Лесопилка</h1>\n" });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });

async function setup(script: FakeTurn[]) {
  fake = await startFakeProvider({ key: KEY, script, models: [{ id: "coder", supported_parameters: ["tools"] }] });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Fake", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  const project = await (await env.call("POST", "/api/projects", { path: folder })).json();
  const add = async (title: string, size = "S") =>
    (await (await env.call("POST", `/api/projects/${project.id}/backlog`, { title, done: [`${title}: работает`], size })).json()) as { id: string };
  const calc = await add("Калькулятор");
  const cart = await add("Корзина");
  return { provider, project, calc, cart };
}

const items = async (projectId: string) => (await (await env.call("GET", `/api/projects/${projectId}/backlog`)).json()).items as any[];
const say = async (chatId: string, content: string) => readEvents(await env.call("POST", `/api/chats/${chatId}/messages`, { content }));

describe("a task of the list as a conversation in the project's folder", () => {
  it("opens a conversation in the folder, with the task as its first message and a point to roll back to", async () => {
    const { provider, project, calc, cart } = await setup([]);
    const res = await env.call("POST", `/api/projects/${project.id}/backlog/run`, { ids: [calc.id, cart.id], providerId: provider.id, model: "coder" });
    expect(res.status).toBe(201);
    const started = await res.json();
    expect(started).toMatchObject({ itemId: calc.id, chatId: expect.any(String) });
    expect(started.message).toContain("Калькулятор");
    expect(started.message).toContain("Калькулятор: работает");

    const chat = await (await env.call("GET", `/api/chats/${started.chatId}`)).json();
    expect(chat).toMatchObject({ folder, projectId: project.id, itemId: calc.id, title: "Калькулятор" });
    const list = await items(project.id);
    expect(list.find((i) => i.id === calc.id)).toMatchObject({ status: "active", chatId: started.chatId });
    expect(list.find((i) => i.id === cart.id)).toMatchObject({ status: "picked" });
    expect(git(folder, "rev-parse", `refs/artel/item/${calc.id}`)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("works right in the folder; once it answers, the task waits for review with what changed", async () => {
    const { provider, project, calc } = await setup([
      call("write_file", { path: "calculator.html", content: "<form>калькулятор</form>\n" }),
      call("edit_file", { path: "index.html", old: "<h1>Лесопилка</h1>", new: '<h1>Лесопилка</h1>\n<a href="calculator.html">Калькулятор</a>' }),
      { text: "Готово: калькулятор на calculator.html. Запуск: откройте index.html." },
    ]);
    const started = await (await env.call("POST", `/api/projects/${project.id}/backlog/run`, { ids: [calc.id], providerId: provider.id, model: "coder" })).json();
    const events = await say(started.chatId, started.message);
    expect(events.at(-1)).toMatchObject({ type: "done", message: { status: "done" } });
    expect(readFileSync(join(folder, "calculator.html"), "utf8")).toContain("калькулятор");

    expect((await items(project.id)).find((i) => i.id === calc.id)).toMatchObject({ status: "review" });
    const changes = await (await env.call("GET", `/api/projects/${project.id}/backlog/${calc.id}/changes`)).json();
    expect(changes.files).toEqual([
      { path: "calculator.html", status: "added" },
      { path: "index.html", status: "modified" },
    ]);
    // Line by line too, as the review of the old pipeline showed it (seen: only file names in a task's review).
    expect(changes.diff.map((f: any) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["calculator.html", "added", expect.any(Number), 0],
      ["index.html", "modified", expect.any(Number), expect.any(Number)],
    ]);
    expect(changes.diff[1].hunks[0].lines.some((l: any) => l.kind === "add")).toBe(true);

    // The agent was told the project's rules, in the system text of every step.
    const system = JSON.stringify(fake!.requests.find((r) => r.path === "/v1/chat/completions")!.body.messages[0]);
    expect(system).toMatch(/English/);
    expect(system).toMatch(/npm install/);
    expect(system).toMatch(/run/i);

    // A note from the user puts it back to work, and the next answer back to review.
    // (the script has run out: the model answers "Done.")
    await say(started.chatId, "Кнопка не видна на телефоне");
    expect((await items(project.id)).find((i) => i.id === calc.id)).toMatchObject({ status: "review" });
  });

  it("accepts the task as one commit and starts the next one in a new conversation", async () => {
    const { provider, project, calc, cart } = await setup([call("write_file", { path: "calculator.html", content: "<form></form>\n" }), { text: "Готово." }]);
    const started = await (await env.call("POST", `/api/projects/${project.id}/backlog/run`, { ids: [calc.id, cart.id], providerId: provider.id, model: "coder" })).json();
    await say(started.chatId, started.message);

    const accepted = await env.call("POST", `/api/projects/${project.id}/backlog/${calc.id}/accept`, {});
    expect(accepted.status).toBe(200);
    expect(git(folder, "log", "-1", "--format=%s")).toBe("Калькулятор");
    expect(git(folder, "status", "--porcelain")).toBe("");
    expect((await items(project.id)).find((i) => i.id === calc.id)).toMatchObject({ status: "done" });
    expect(() => git(folder, "rev-parse", "--verify", "--quiet", `refs/artel/item/${calc.id}`)).toThrow();

    const next = await (await env.call("POST", `/api/projects/${project.id}/backlog/next`)).json();
    expect(next).toMatchObject({ itemId: cart.id });
    expect(next.chatId).not.toBe(started.chatId);
  });

  it("rolls the task back: the folder as it was, the task back in the list", async () => {
    const { provider, project, calc } = await setup([
      call("write_file", { path: "calculator.html", content: "<form></form>\n" }),
      call("write_file", { path: "index.html", content: "<h1>Сломано</h1>\n" }),
      { text: "Готово." },
    ]);
    const started = await (await env.call("POST", `/api/projects/${project.id}/backlog/run`, { ids: [calc.id], providerId: provider.id, model: "coder" })).json();
    await say(started.chatId, started.message);

    expect((await env.call("POST", `/api/projects/${project.id}/backlog/${calc.id}/undo`)).status).toBe(200);
    expect(existsSync(join(folder, "calculator.html"))).toBe(false);
    expect(readFileSync(join(folder, "index.html"), "utf8")).toBe("<h1>Лесопилка</h1>\n");
    expect((await items(project.id)).find((i) => i.id === calc.id)).toMatchObject({ status: "open", chatId: null });
    expect(execFileSync("git", ["log", "--oneline"], { cwd: folder, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
  });

  it("offers the project's skills, and the agent can open one", async () => {
    mkdirSync(join(folder, ".artel", "skills", "style"), { recursive: true });
    writeFileSync(join(folder, ".artel", "skills", "style", "SKILL.md"), ["---", "name: style", "description: When making pages for this site", "---", "Use the brand green.", ""].join("\n"));
    const { provider, project, calc } = await setup([call("use_skill", { name: "style" }), { text: "Готово." }]);
    const started = await (await env.call("POST", `/api/projects/${project.id}/backlog/run`, { ids: [calc.id], providerId: provider.id, model: "coder" })).json();
    const events = await say(started.chatId, started.message);
    const requests = fake!.requests.filter((r) => r.path === "/v1/chat/completions");
    expect(JSON.stringify(requests[0]!.body.messages[0])).toContain("style: When making pages for this site");
    expect(JSON.stringify(requests[1]!.body.messages)).toContain("Use the brand green.");
    // The answer's actions name the skill (seen live: "use_skill" with nothing after it).
    expect(events).toContainEqual({ type: "tool", name: "use_skill", input: "style" });
  });

  it("names its project and task in the list of chats, so the sidebar shows it under the project", async () => {
    const { provider, project, calc } = await setup([]);
    const started = await (await env.call("POST", `/api/projects/${project.id}/backlog/run`, { ids: [calc.id], providerId: provider.id, model: "coder" })).json();
    const all = await (await env.call("GET", "/api/chats")).json();
    expect(all.find((c: any) => c.id === started.chatId)).toMatchObject({ projectId: project.id, itemId: calc.id });
  });

  it("is done by Claude Code itself in the project's folder when the model is on a subscription", async () => {
    const dir = mkdtempSync(join(tmpdir(), "artel-fake-cli-"));
    process.env.FAKE_CLI_DIR = dir;
    writeFileSync(join(dir, "script.json"), JSON.stringify([{ text: "Сделал калькулятор.", files: { "calculator.html": "<form></form>\n" } }]));
    env.setCliCommand("claude-code", [process.execPath, fileURLToPath(new URL("./fake-cli.mjs", import.meta.url)), "claude"]);
    const { project, calc } = await setup([]);
    const provider = await (await env.call("POST", "/api/providers", { preset: "claude-code" })).json();
    const started = await (await env.call("POST", `/api/projects/${project.id}/backlog/run`, { ids: [calc.id], providerId: provider.id, model: "default" })).json();
    await say(started.chatId, started.message);
    expect(readFileSync(join(folder, "calculator.html"), "utf8")).toBe("<form></form>\n");
    const run = JSON.parse(readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n")[0]!);
    expect(run.args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]));
    expect(run.prompt).toMatch(/English/);
    expect((await items(project.id)).find((i) => i.id === calc.id)).toMatchObject({ status: "review" });
    rmSync(dir, { recursive: true, force: true });
  });
});
