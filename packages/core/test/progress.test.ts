import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { makeRepo } from "./git-repo";

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider | undefined;
let repo: string;

const FAILING =
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("sky", () => assert.equal(1, 2));\n';

beforeEach(() => {
  env = createTestEnv();
  repo = makeRepo({ "package.json": '{ "type": "module" }\n', "sky.test.js": FAILING });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });
const look = call("list_files", { path: "." });
const spec = call("propose_spec", { spec: "# Небо", checks: ["node --test"], plan: ["Небо"] });

async function start(coder: FakeTurn[], strong?: string) {
  const queue = [...coder];
  fake = await startFakeProvider({ key: KEY, models: [{ id: "coder" }, { id: "strong" }], respond: () => queue.shift() ?? look });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  if (strong) await env.call("PATCH", "/api/settings", { strongModel: { providerId: provider.id, model: strong } });
  const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
  const res = await env.call("POST", `/api/projects/${project.id}/tasks`, {
    task: "Сделай небо",
    providerId: provider.id,
    model: "coder",
    stages: { interview: false, spec: true, approveSpec: false, testsFirst: false },
  });
  return (await res.json()).id as string;
}

async function waitFor(id: string, check: (task: any) => boolean, timeoutMs = 60_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const task = await (await env.call("GET", `/api/tasks/${id}`)).json();
    if (check(task)) return task;
    if (Date.now() > until) throw new Error(`stuck: ${task.status}/${task.statusReason}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const settled = (t: any) => !["running", "queued"].includes(t.status);
const chats = () => fake!.requests.filter((r) => r.path === "/v1/chat/completions");

// Seen live: an agent patched a big file in circles for hundreds of steps while the type errors grew; Artel went on
// past each step limit without looking.
describe("progress at the step limit", () => {
  it("shows the agent where the checks stand, and stops when sixty more steps brought them no closer", async () => {
    const id = await start([spec]);
    const task = await waitFor(id, settled);
    expect(task).toMatchObject({ status: "waiting", statusReason: "stuck" });
    expect(task.steps).toBeLessThan(130);
    const told = chats().map((r) => JSON.stringify(r.body.messages)).find((m) => m.includes("Where the checks stand"));
    expect(told).toContain("node --test");
  });

  it("hands the work to the strong model instead, when there is one", async () => {
    const id = await start([spec], "strong");
    await waitFor(id, (t) => t.model === "strong");
    const task = await (await env.call("GET", `/api/tasks/${id}`)).json();
    expect(task.escalated).toBe(true);
  });
});
