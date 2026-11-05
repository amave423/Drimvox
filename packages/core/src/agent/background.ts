import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { killTree, spawnShell } from "./commands";

interface Proc {
  id: number;
  command: string;
  cwd: string;
  startedAt: number;
  child: ChildProcessWithoutNullStreams;
  output: string;
  exitCode: number | null | undefined;
}

const KEEP = 20_000;
/** At most this many at once per task; a dev server and a watcher are the usual pair. */
const MAX_PER_TASK = 4;

/**
 * Long-running commands of a task, such as a dev server: started in the task's copy, read while they run,
 * and all stopped when the task's run ends.
 */
export class Background {
  private readonly tasks = new Map<string, { next: number; procs: Map<number, Proc> }>();

  start(taskId: string, command: string, cwd: string): Proc {
    const entry = this.tasks.get(taskId) ?? { next: 1, procs: new Map<number, Proc>() };
    this.tasks.set(taskId, entry);
    const running = [...entry.procs.values()].filter((p) => p.exitCode === undefined);
    if (running.length >= MAX_PER_TASK) throw new Error(`At most ${MAX_PER_TASK} background processes; stop one first.`);
    const child = spawnShell(command, cwd);
    const proc: Proc = { id: entry.next++, command, cwd, startedAt: Date.now(), child, output: "", exitCode: undefined };
    const append = (chunk: Buffer) => {
      proc.output += chunk.toString("utf8");
      if (proc.output.length > KEEP * 2) proc.output = proc.output.slice(-KEEP);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => (proc.exitCode = code));
    child.on("error", (err) => {
      proc.output += String(err);
      proc.exitCode = null;
    });
    entry.procs.set(proc.id, proc);
    return proc;
  }

  /** The same command still running for this task (seen live: a second server on the port of the first). */
  runningAs(taskId: string, command: string): Proc | undefined {
    const same = (c: string) => c.trim().replace(/\s+/g, " ");
    return [...(this.tasks.get(taskId)?.procs.values() ?? [])].find((p) => p.exitCode === undefined && same(p.command) === same(command));
  }

  /** Everything running now, of every task (asked for: to see what runs and stop what is not needed). */
  running(): { key: string; id: number; command: string; cwd: string; startedAt: number; pid: number | null }[] {
    return [...this.tasks].flatMap(([key, entry]) =>
      [...entry.procs.values()].filter((p) => p.exitCode === undefined).map((p) => ({ key, id: p.id, command: p.command, cwd: p.cwd, startedAt: p.startedAt, pid: p.child.pid ?? null })),
    );
  }

  get(taskId: string, id: number): Proc | undefined {
    return this.tasks.get(taskId)?.procs.get(id);
  }

  /** The end of a process's output and whether it still runs. */
  read(taskId: string, id: number): string {
    const p = this.get(taskId, id);
    if (!p) throw new Error(`No background process ${id}`);
    const state = p.exitCode === undefined ? "running" : `exited with code ${p.exitCode}`;
    const tail = p.output.length > 8000 ? `…\n${p.output.slice(-8000)}` : p.output;
    return `Process ${p.id} (${state}): ${p.command}\n${tail.trimEnd() || "(no output yet)"}`;
  }

  stop(taskId: string, id: number): boolean {
    const p = this.get(taskId, id);
    if (!p) return false;
    killTree(p.child);
    return true;
  }

  stopAll(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    for (const p of entry.procs.values()) killTree(p.child);
    this.tasks.delete(taskId);
  }

  shutdown(): void {
    for (const id of [...this.tasks.keys()]) this.stopAll(id);
  }
}
