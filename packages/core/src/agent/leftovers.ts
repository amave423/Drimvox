import { execFile, spawn } from "node:child_process";

/**
 * Programs an agent's command left running after the command ended: a server started with `&`, a window it opened. Seen
 * live: ten Nexus servers the agents had started over a day were still running, holding ports 8091–8099, and the next
 * model spent its whole budget looking for a free one. Each shell a command runs in is remembered by its folder; when
 * the run is over, whatever those shells started and left is stopped.
 */
const shells = new Map<string, { pid: number; since: number }[]>();

export function noteShell(folder: string, pid: number | undefined, since: Date): void {
  if (!pid) return;
  const list = shells.get(folder) ?? [];
  list.push({ pid, since: since.getTime() });
  shells.set(folder, list);
}

export interface ProcessRow {
  ProcessId: number;
  ParentProcessId: number;
  /** When it started, ISO. */
  Created: string;
}

/**
 * What the shells started, at any depth: a child's parent may be gone (Windows keeps its number), so a process counts
 * when its parent is one of ours and it started after that shell did. The shells themselves are left out.
 */
export function leftoversOf(list: ProcessRow[], roots: { pid: number; since: number }[]): number[] {
  const since = new Map(roots.map((r) => [r.pid, r.since]));
  const found: number[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of list) {
      const parent = since.get(p.ParentProcessId);
      if (parent === undefined || since.has(p.ProcessId) || new Date(p.Created).getTime() < parent) continue;
      since.set(p.ProcessId, parent);
      found.push(p.ProcessId);
      grew = true;
    }
  }
  return found;
}

/** Stops what the commands run in `folder` left running; never throws. */
export function stopLeftovers(folder: string): Promise<void> {
  const roots = shells.get(folder);
  shells.delete(folder);
  if (!roots?.length) return Promise.resolve();
  if (process.platform !== "win32") {
    // Each shell has a process group of its own: what it started is in it.
    for (const r of roots) {
      try {
        process.kill(-r.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    return Promise.resolve();
  }
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, " +
    "@{ n = 'Created'; e = { $_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (!err && String(out).trim()) {
        try {
          const parsed = JSON.parse(String(out)) as ProcessRow | ProcessRow[];
          for (const pid of leftoversOf(Array.isArray(parsed) ? parsed : [parsed], roots)) {
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
          }
        } catch {
          // Nothing readable: nothing to stop.
        }
      }
      resolve();
    });
  });
}
