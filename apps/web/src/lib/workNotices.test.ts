import type { ProjectWorkView } from "@drimvox/shared";
import { describe, expect, it } from "vitest";
import { workNotices } from "./workNotices";

const work = (projectId: string, status: ProjectWorkView["status"], waitingApproval = false, reason: ProjectWorkView["reason"] = null) =>
  ({ projectId, status, waitingApproval, reason, planTaskId: `plan-${projectId}` }) as ProjectWorkView;

describe("workNotices", () => {
  // Seen live: a project waited half an hour on a permission nobody saw.
  it("announces a run that waits for permission, is done, or stopped", () => {
    const before = [work("a", "running"), work("b", "running"), work("c", "running")];
    const after = [work("a", "running", true), work("b", "done"), work("c", "paused", false, "budget")];
    expect(workNotices(before, after).map((n) => [n.projectId, n.kind])).toEqual([
      ["a", "approval"],
      ["b", "done"],
      ["c", "paused"],
    ]);
  });

  it("says nothing on the first look or when nothing changed", () => {
    expect(workNotices(null, [work("a", "done")])).toEqual([]);
    expect(workNotices([work("a", "running", true)], [work("a", "running", true)])).toEqual([]);
  });
});
