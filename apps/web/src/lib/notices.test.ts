import type { TaskView } from "@drimvox/shared";
import { describe, expect, it } from "vitest";
import { noticesFor } from "./notices";

const task = (id: string, status: TaskView["status"], statusReason: string | null = null) =>
  ({ id, title: `Задача ${id}`, status, statusReason }) as TaskView;

describe("noticesFor", () => {
  it("announces a task that became ready, needs an answer, got stuck or failed", () => {
    const before = [task("a", "running"), task("b", "running"), task("c", "running"), task("d", "running"), task("e", "running")];
    const after = [
      task("a", "review"),
      task("b", "waiting", "spec_review"),
      task("c", "waiting", "stuck"),
      task("d", "failed", "provider_error"),
      task("e", "done_empty", "answered"),
    ];
    expect(noticesFor(before, after).map((n) => [n.taskId, n.kind])).toEqual([
      ["a", "review"],
      ["b", "waiting"],
      ["c", "stuck"],
      ["d", "failed"],
      ["e", "answered"],
    ]);
  });

  it("stays quiet when nothing changed, on the first load and for running work", () => {
    expect(noticesFor([task("a", "review")], [task("a", "review")])).toEqual([]);
    expect(noticesFor(null, [task("a", "review")])).toEqual([]);
    expect(noticesFor([task("a", "waiting", "approval")], [task("a", "running")])).toEqual([]);
  });

  it("announces a new reason to wait even when the task was already waiting", () => {
    const n = noticesFor([task("a", "waiting", "questions")], [task("a", "waiting", "spec_review")]);
    expect(n.map((x) => x.kind)).toEqual(["waiting"]);
  });
});
