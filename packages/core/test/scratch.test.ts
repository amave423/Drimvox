import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCommand } from "../src/agent/commands";
import { agentPrompt, scratchOf } from "../src/work/agent-prompt";

// Seen live: models made scratchpad/, temp/ and a file named nul in the project's root. They are given one folder.
describe("the agent's scratch folder", () => {
  const project = join(process.cwd(), "src");

  it("is one folder per project in the temporary folder, named in the agent's instructions", () => {
    const scratch = scratchOf(project);
    expect(relative(tmpdir(), scratch).startsWith("..")).toBe(false);
    expect(scratchOf(project)).toBe(scratch);
    expect(scratchOf(join(project, "other"))).not.toBe(scratch);
    expect(agentPrompt(project)).toContain(scratch);
  });

  it("is used without asking", () => {
    const scratch = scratchOf(project).split("\\").join("/");
    expect(classifyCommand(`mkdir -p "${scratch}" && node "${scratch}/probe.mjs"`, project)).toEqual({ action: "allow" });
  });
});
