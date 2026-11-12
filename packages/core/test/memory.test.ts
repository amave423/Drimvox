import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeTurn } from "./fake-provider";
import { makeRepo } from "./git-repo";
import { projectRun, waitWork } from "./project-run";
import { memoryLimit } from "../src/agent/memory";

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

/** A project's agent writing notes; it answers in text when its queue is over. */
async function start(coder: FakeTurn[]) {
  const queue = [...coder];
  fake = await startFakeProvider({
    key: KEY,
    // A window of 32 thousand tokens: the summary comes at 80 % of it (about 90 thousand characters), below what a
    // project's run keeps whole of the newest outputs (prune.ts), so the reads overflow it all the same.
    models: [{ id: "coder", context_length: 32_000, supported_parameters: ["tools"] }],
    respond: (body) => (isSummarizer(body) ? { text: "SUMMARY" } : (queue.shift() ?? { text: "Готово." })),
  });
  return (await projectRun(env, fake, repo, "Запиши заметки")).projectId;
}

const settle = (projectId: string) => waitWork(env, projectId);

const coderRequests = () => fake!.requests.filter((r) => r.path === "/v1/chat/completions" && !isSummarizer(r.body)).map((r) => r.body.messages as any[]);

describe("the agent's memory", () => {
  // Seen live: the time to the minute in the system prompt changed the start of every request each minute, so the
  // provider's cache never held over a long task (16.7M input tokens at full price for one small site).
  it("keeps the system prompt the same from step to step: the date, not the time", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-18T10:00:00Z") });
    try {
      // The first answer comes late: the next request goes out after the clock moved on.
      const id = await start([{ ...call("read_file", { path: "src/app.ts" }), delayMs: 800 }]);
      await vi.waitFor(() => expect(coderRequests().length).toBeGreaterThan(0));
      vi.setSystemTime(new Date("2026-10-18T10:07:00Z"));
      await settle(id);
      const systems = new Set(coderRequests().map((m) => JSON.stringify(m[0])));
      expect(systems.size).toBe(1);
      expect([...systems][0]).toContain("2026");
    } finally {
      vi.useRealTimers();
    }
  });

  // Asked for: as OpenCode, the whole history until the model's window nears (the old 400 000 characters cap made the
  // agent forget what it had read and read it again).
  it("sums up at 80 % of the model's window, a large window too", () => {
    const model = (contextLength: number) => ({ id: "m", name: "m", contextLength, priceIn: 0, priceOut: 0, priceEstimated: false, tools: true, vision: null });
    expect(memoryLimit(model(1_000_000))).toBe(2_800_000);
    expect(memoryLimit(model(32_000))).toBe(89_600);
    expect(memoryLimit(undefined)).toBe(358_400);
  });

  it("leaves a short conversation as it is", async () => {
    const id = await start([call("read_file", { path: "src/app.ts" })]);
    await settle(id);
    expect(fake!.requests.some((r) => isSummarizer(r.body))).toBe(false);
  });
});
