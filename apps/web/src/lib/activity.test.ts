import type { TaskEvent } from "@artel/shared";
import { describe, expect, it } from "vitest";
import { buildFeed, exitCodeOf } from "./activity";

const ev = (seq: number, kind: TaskEvent["kind"], data: unknown): TaskEvent => ({ seq, kind, data, createdAt: seq });

describe("buildFeed", () => {
  it("joins tool calls with their results and keeps the order", () => {
    const feed = buildFeed([
      ev(1, "user", { text: "Добавь тест" }),
      ev(2, "text", { text: "Смотрю файлы." }),
      ev(3, "tool_call", { callId: "a", name: "read_file", input: { path: "src/app.ts" } }),
      ev(4, "tool_result", { callId: "a", name: "read_file", ok: true, output: "1\tx" }),
      ev(5, "tool_call", { callId: "b", name: "run_command", input: { command: "npm test" } }),
    ]);
    expect(feed).toEqual([
      { kind: "user", seq: 1, text: "Добавь тест" },
      { kind: "note", seq: 2, text: "Смотрю файлы." },
      { kind: "action", seq: 3, callId: "a", name: "read_file", input: { path: "src/app.ts" }, result: { ok: true, output: "1\tx" } },
      { kind: "action", seq: 5, callId: "b", name: "run_command", input: { command: "npm test" }, result: null },
    ]);
  });

  it("updates an approval when the user answers", () => {
    const feed = buildFeed([
      ev(1, "approval", { id: "p", command: "git push", reason: "push", allowed: null }),
      ev(2, "approval", { id: "p", command: "git push", reason: "push", allowed: false }),
    ]);
    expect(feed).toEqual([{ kind: "approval", seq: 1, id: "p", command: "git push", reason: "push", allowed: false }]);
  });

  it("leaves finish out of the actions and keeps status lines", () => {
    const feed = buildFeed([
      ev(1, "tool_call", { callId: "f", name: "finish", input: { summary: "ok" } }),
      ev(2, "tool_result", { callId: "f", name: "finish", ok: true, output: "Finished." }),
      ev(3, "status", { status: "review", reason: null, detail: null }),
    ]);
    expect(feed).toEqual([{ kind: "status", seq: 3, status: "review", reason: null, detail: null }]);
  });
});

describe("pipeline events", () => {
  it("turns steps, questions, answers, specs, checks and escalations into lines", () => {
    const feed = buildFeed([
      ev(1, "phase", { phase: "interview" }),
      ev(2, "tool_call", { callId: "q", name: "ask_questions", input: {} }),
      ev(3, "questions", { questions: [{ id: "a", question: "Как назвать?" }] }),
      ev(4, "answers", { answers: [{ id: "a", answer: "subtract" }], skipped: false }),
      ev(5, "spec", { spec: "# Спека", checks: ["npm test"], plan: [] }),
      ev(6, "check", { phase: "code", command: "npm test", exitCode: 1, ok: false, output: "FAIL" }),
      ev(7, "escalation", { from: "small", to: "strong" }),
    ]);
    expect(feed.map((i) => i.kind)).toEqual(["phase", "questions", "answers", "spec", "check", "escalation"]);
    expect(feed[4]).toMatchObject({ command: "npm test", exitCode: 1, ok: false });
  });
});

describe("exitCodeOf", () => {
  it("reads the exit code from command output", () => {
    expect(exitCodeOf("Exit code: 1\nFAIL")).toBe(1);
    expect(exitCodeOf("Timed out after 120s\n")).toBeNull();
  });
});
