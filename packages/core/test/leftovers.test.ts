import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/agent/commands";
import { leftoversOf, stopLeftovers } from "../src/agent/leftovers";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("what an agent's commands leave running", () => {
  it("finds what the shells started at any depth, after them, and not the shells or older processes", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 14, 0, 0, s)).toISOString();
    const shellSince = Date.parse(at(10));
    const list = [
      { ProcessId: 100, ParentProcessId: 1, Created: at(10) }, // the shell
      { ProcessId: 101, ParentProcessId: 100, Created: at(11) }, // a server it started with &
      { ProcessId: 102, ParentProcessId: 101, Created: at(12) }, // that server's worker
      { ProcessId: 103, ParentProcessId: 100, Created: at(5) }, // an older process that got a reused parent number
      { ProcessId: 104, ParentProcessId: 7, Created: at(12) }, // someone else's
    ];
    expect(leftoversOf(list, [{ pid: 100, since: shellSince }]).sort()).toEqual([101, 102]);
  });

  // Seen live: ten Nexus servers started by agents over a day still held ports 8091–8099.
  it("stops a server a command started with & once the run in that folder is over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drimvox-leftover-"));
    try {
      const script = "require('fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(() => {}, 60000)";
      const result = await runCommand(`node -e "${script}" > /dev/null 2>&1 &`, dir, 20_000);
      expect(result.timedOut).toBe(false);
      for (let i = 0; i < 50 && !existsSync(join(dir, "pid.txt")); i++) await new Promise((r) => setTimeout(r, 100));
      const pid = Number(readFileSync(join(dir, "pid.txt"), "utf8"));
      expect(alive(pid)).toBe(true);
      await stopLeftovers(dir);
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
