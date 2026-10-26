import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASE, auth, createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { makeRepo } from "./git-repo";
import { HEADLESS_PLAYWRIGHT } from "../src/db";

const KEY = "good-key";
const SERVER = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
let env: TestEnv;
let fake: FakeProvider | undefined;
let repo: string;

beforeEach(() => {
  env = createTestEnv();
  repo = makeRepo({ "README.md": "# Demo\n" });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function addServer(extra: Record<string, unknown> = {}) {
  const res = await env.call("POST", "/api/mcp", { name: "demo", command: process.execPath, args: [SERVER], ...extra });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

describe("servers", () => {
  it("connects to a server and lists its tools", async () => {
    const id = await addServer();
    const status = await (await env.call("GET", `/api/mcp/${id}/status`)).json();
    expect(status.ok).toBe(true);
    expect(status.tools.map((t: any) => t.name).sort()).toEqual(["add", "echo", "secret"]);
  });

  it("keeps environment values secret and passes them to the server", async () => {
    const id = await addServer({ env: { DEMO_TOKEN: "abc123" } });
    const [view] = await (await env.call("GET", "/api/mcp")).json();
    expect(view).toMatchObject({ id, name: "demo", transport: "stdio", envKeys: ["DEMO_TOKEN"], enabled: true, allowed: [] });
    expect(JSON.stringify(view)).not.toContain("abc123");
    const row = env.db.sql.prepare("select env_secret from mcp_servers").get() as { env_secret: string };
    expect(row.env_secret).not.toContain("abc123");
  });

  it("explains a server that cannot start", async () => {
    const res = await env.call("POST", "/api/mcp", { name: "broken", command: "definitely-not-a-command-xyz" });
    const status = await (await env.call("GET", `/api/mcp/${(await res.json()).id}/status`)).json();
    expect(status.ok).toBe(false);
    expect(status.error).toBeTruthy();
  });

  // Asked for: the browser of the Playwright server kept jumping in front; it works out of sight now.
  it("moves a Playwright server already added to a browser out of sight, leaving the others and a chosen window alone", async () => {
    const add = async (name: string, args: string[]) => (await (await env.call("POST", "/api/mcp", { name, command: "npx", args })).json()).id as string;
    const shown = await add("Playwright", ["-y", "@playwright/mcp@latest"]);
    const headed = await add("Окно", ["-y", "@playwright/mcp@latest", "--headed"]);
    const other = await add("Другой", ["-y", "some-server"]);
    // What the new version does once to a database made before it.
    env.db.sql.exec(HEADLESS_PLAYWRIGHT);
    const args = (id: string) => JSON.parse((env.db.sql.prepare("select args from mcp_servers where id = ?").get(id) as { args: string }).args);
    expect(args(shown)).toEqual(["-y", "@playwright/mcp@latest", "--headless"]);
    expect(args(headed)).toEqual(["-y", "@playwright/mcp@latest", "--headed"]);
    expect(args(other)).toEqual(["-y", "some-server"]);
  });

  it("switches a server off and deletes it", async () => {
    const id = await addServer();
    expect((await (await env.call("PATCH", `/api/mcp/${id}`, { enabled: false })).json()).enabled).toBe(false);
    expect((await env.call("DELETE", `/api/mcp/${id}`)).status).toBe(204);
    expect(await (await env.call("GET", "/api/mcp")).json()).toEqual([]);
  });
});

describe("tools for agents", () => {
  async function runTask(script: FakeTurn[]) {
    fake = await startFakeProvider({ key: KEY, script, models: [{ id: "coder" }] });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
    const stages = { interview: false, spec: false, approveSpec: false, testsFirst: false };
    const task = await (await env.call("POST", `/api/projects/${project.id}/tasks`, { task: "Сложи", providerId: provider.id, model: "coder", stages })).json();
    return task.id as string;
  }
  const waitTask = async (id: string, check: (t: any) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const t = await (await env.call("GET", `/api/tasks/${id}`)).json();
      if (check(t)) return t;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("task stuck");
  };
  const add = { toolCalls: [{ name: "mcp_demo_add", args: { a: 2, b: 3 } }] };
  const finish = { toolCalls: [{ name: "finish", args: { summary: "Готово", commit_message: "Done" } }] };

  it("asks before the first call, remembers \"always\" and calls without asking afterwards", async () => {
    const serverId = await addServer();
    const id = await runTask([add, add, finish]);
    const waiting = await waitTask(id, (t) => t.pendingApproval);
    expect(waiting.pendingApproval).toMatchObject({ reason: "mcp" });
    expect(waiting.pendingApproval.command).toContain("demo");
    expect(waiting.pendingApproval.command).toContain("add");
    await env.call("POST", `/api/tasks/${id}/approvals/${waiting.pendingApproval.id}`, { allow: true, always: true });
    await waitTask(id, (t) => t.status === "done_empty");

    const results = (await (await env.call("GET", `/api/tasks/${id}/events`)).json()).filter((e: any) => e.kind === "tool_result");
    expect(results.map((e: any) => e.data.output)).toEqual(["5", "5", "Finished."]);
    const approvals = (await (await env.call("GET", `/api/tasks/${id}/events`)).json()).filter((e: any) => e.kind === "approval");
    expect(approvals).toHaveLength(2);
    expect((await (await env.call("GET", "/api/mcp")).json())[0].allowed).toEqual(["add"]);

    expect((await env.call("DELETE", `/api/mcp/${serverId}/allowed/add`)).status).toBe(204);
    expect((await (await env.call("GET", "/api/mcp")).json())[0].allowed).toEqual([]);
  });

  it("tells the agent when the user says no", async () => {
    await addServer();
    const id = await runTask([add, finish]);
    const waiting = await waitTask(id, (t) => t.pendingApproval);
    await env.call("POST", `/api/tasks/${id}/approvals/${waiting.pendingApproval.id}`, { allow: false });
    await waitTask(id, (t) => t.status === "done_empty");
    const result = (await (await env.call("GET", `/api/tasks/${id}/events`)).json()).find((e: any) => e.kind === "tool_result");
    expect(result.data).toMatchObject({ ok: false });
    expect(result.data.output).toMatch(/did not allow/);
  });

  it("gives a switched-off server's tools to nobody", async () => {
    const serverId = await addServer();
    await env.call("PATCH", `/api/mcp/${serverId}`, { enabled: false });
    await runTask([finish]);
    for (let i = 0; i < 100 && !fake!.requests.some((r) => r.path === "/v1/chat/completions"); i++) await new Promise((r) => setTimeout(r, 20));
    const tools = fake!.requests.find((r) => r.path === "/v1/chat/completions")!.body.tools.map((t: any) => t.function.name);
    expect(tools.some((n: string) => n.startsWith("mcp_"))).toBe(false);
  });
});

describe("tools in a chat", () => {
  it("asks in the answer and goes on after the OK", async () => {
    await addServer();
    fake = await startFakeProvider({
      key: KEY,
      models: [{ id: "chatty" }],
      script: [{ toolCalls: [{ name: "mcp_demo_echo", args: { text: "привет" } }] }, { text: "Сервер ответил: echo: привет" }],
    });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const chat = await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "chatty" })).json();

    // The answer's stream stays open while the chat waits for the OK, so it is read as it comes.
    const res = await env.app().request(`${BASE}/api/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Повтори привет", web: "off" }),
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const events: any[] = [];
    let buffer = "";
    let answered = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const line = buffer.slice(0, end).split("\n").find((l) => l.startsWith("data: "));
        buffer = buffer.slice(end + 2);
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        events.push(event);
        if (event.type === "approval" && !answered) {
          answered = true;
          expect(event).toMatchObject({ server: "demo", tool: "echo", input: { text: "привет" } });
          // A window that comes back to the chat sees the open request too (seen: a task waited hours on a card nobody saw).
          const open = await (await env.call("GET", `/api/chats/${chat.id}`)).json();
          expect(open.approvals).toEqual([expect.objectContaining({ id: event.id, server: "demo", tool: "echo" })]);
          const ok = await env.call("POST", `/api/chats/${chat.id}/approvals/${event.id}`, { allow: true });
          expect(ok.status).toBe(200);
        }
      }
    }
    expect(events.find((e) => e.type === "done").message).toMatchObject({ status: "done", content: "Сервер ответил: echo: привет" });
    expect((await (await env.call("GET", `/api/chats/${chat.id}`)).json()).approvals).toEqual([]);
    const lastChat = fake.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!;
    expect(JSON.stringify(lastChat.body.messages)).toContain("echo: привет");
  });

  // Seen live: a browser server has some twenty tools, and each one asked on its own; the run waited on the next.
  it("trusts a whole server at once: its other tools no longer ask", async () => {
    const serverId = await addServer();
    fake = await startFakeProvider({
      key: KEY,
      models: [{ id: "chatty" }],
      script: [
        { toolCalls: [{ name: "mcp_demo_echo", args: { text: "раз" } }] },
        { toolCalls: [{ name: "mcp_demo_add", args: { a: 2, b: 3 } }] },
        { text: "Готово." },
      ],
    });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const chat = await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "chatty" })).json();
    const res = await env.app().request(`${BASE}/api/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Два инструмента", web: "off" }),
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const asked: string[] = [];
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const line = buffer.slice(0, end).split("\n").find((l) => l.startsWith("data: "));
        buffer = buffer.slice(end + 2);
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === "approval") {
          asked.push(event.tool);
          await env.call("POST", `/api/chats/${chat.id}/approvals/${event.id}`, { allow: true, server: true });
        }
      }
    }
    expect(asked).toEqual(["echo"]);
    expect((await (await env.call("GET", "/api/mcp")).json()).find((s: any) => s.id === serverId).allowed).toEqual(["*"]);
  });

  // Seen live: a browser server (Playwright MCP) opened the page, typed and clicked, and the answer stopped at 8 steps
  // before the results came: a chat with MCP tools gets the room of a chat with the internet.
  it("gives an answer with MCP tools far more than 8 steps", async () => {
    await addServer();
    const echo = (n: number) => ({ toolCalls: [{ name: "mcp_demo_echo", args: { text: `шаг ${n}` } }] });
    fake = await startFakeProvider({ key: KEY, models: [{ id: "chatty" }], script: [...Array.from({ length: 12 }, (_, n) => echo(n)), { text: "Сделал двенадцать шагов." }] });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const chat = await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "chatty" })).json();
    const res = await env.app().request(`${BASE}/api/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Двенадцать шагов", web: "off" }),
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let done: any = null;
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const line = buffer.slice(0, end).split("\n").find((l) => l.startsWith("data: "));
        buffer = buffer.slice(end + 2);
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === "approval") await env.call("POST", `/api/chats/${chat.id}/approvals/${event.id}`, { allow: true, always: true });
        if (event.type === "done") done = event.message;
      }
    }
    expect(done).toMatchObject({ status: "done", content: "Сделал двенадцать шагов.", error: null });
  });
});
