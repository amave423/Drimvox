import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { makeRepo } from "./git-repo";

vi.setConfig({ testTimeout: 60_000 });

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider | undefined;
let repo: string;

beforeEach(() => {
  env = createTestEnv();
  // About 18 000 characters a read: a dozen of them pass the 200 000 a model of unknown context gets.
  repo = makeRepo({ "big.txt": "строка большого файла\n".repeat(600), "src/app.ts": "export const x = 1;\n" });
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });
const isSummarizer = (body: any) => JSON.stringify(body?.messages?.[0] ?? "").includes("working memory");
const SUMMARY = "SUMMARY: wrote notes.md, read big.txt over and over; next: finish.";

async function start(coder: FakeTurn[]) {
  const queue = [...coder];
  fake = await startFakeProvider({
    key: KEY,
    models: [{ id: "coder" }],
    respond: (body) => (isSummarizer(body) ? { text: SUMMARY } : (queue.shift() ?? call("finish", { summary: "Готово", commit_message: "Notes" }))),
  });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
  const res = await env.call("POST", `/api/projects/${project.id}/tasks`, {
    task: "Запиши заметки",
    providerId: provider.id,
    model: "coder",
    stages: { interview: false, spec: false, approveSpec: false, testsFirst: false },
  });
  return (await res.json()).id as string;
}

async function settle(id: string) {
  for (let i = 0; i < 1200; i++) {
    const task = await (await env.call("GET", `/api/tasks/${id}`)).json();
    if (!["running", "queued"].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("stuck");
}

const coderRequests = () => fake!.requests.filter((r) => r.path === "/v1/chat/completions" && !isSummarizer(r.body)).map((r) => r.body.messages as any[]);

// Seen live: cutting old reads piece by piece made the agent forget the file it edited and read it 156 times.
describe("the agent's memory", () => {
  it("replaces the older work with one summary near the limit, with the files it changed, and keeps the start the same", async () => {
    const reads = Array.from({ length: 14 }, () => call("read_file", { path: "big.txt" }));
    const id = await start([call("write_file", { path: "notes.md", content: "# Заметки\nпервая\n" }), ...reads]);
    const task = await settle(id);
    expect(task.status).toBe("review");

    // One summary, not one a step.
    expect(fake!.requests.filter((r) => r.path === "/v1/chat/completions" && isSummarizer(r.body))).toHaveLength(1);
    const sent = coderRequests();
    const after = sent.filter((m) => JSON.stringify(m).includes(SUMMARY));
    expect(after.length).toBeGreaterThan(1);
    const last = JSON.stringify(sent.at(-1));
    expect(last.length).toBeLessThan(220_000);
    expect(last).toContain("=== notes.md ===");
    expect(last).toContain("# Заметки");
    // The task, then the summary: the same at the start of every request after it, so the provider's cache holds.
    const head = (m: any[]) => JSON.stringify(m.slice(0, 3));
    expect(new Set(after.map(head)).size).toBe(1);
    expect(JSON.stringify(after[0]![1])).toContain("Запиши заметки");
    expect(JSON.stringify(after[0]![2])).toContain(SUMMARY);
  });

  it("leaves a short conversation as it is", async () => {
    const id = await start([call("read_file", { path: "src/app.ts" })]);
    await settle(id);
    expect(fake!.requests.some((r) => isSummarizer(r.body))).toBe(false);
  });
});
