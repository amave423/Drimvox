import { execFile } from "node:child_process";

/** Office programs a script can drive through COM automation; started that way, they run hidden. */
const OFFICE = /^(WINWORD|EXCEL|POWERPNT|MSACCESS|MSPUB|VISIO|OUTLOOK|ONENOTE|WINPROJ)\.EXE$/i;

export interface ProcessInfo {
  ProcessId: number;
  Name: string;
  CommandLine: string | null;
  /** When it started, ISO. */
  Created: string;
}

/**
 * The Office programs a command left behind: started for automation (`-Embedding`) since it began. The user's own
 * windows with documents, and anything older than the command, stay.
 */
export function officeLeftovers(list: ProcessInfo[], since: Date): number[] {
  return list
    .filter((p) => OFFICE.test(p.Name) && /-Embedding|\/Automation/i.test(p.CommandLine ?? "") && new Date(p.Created).getTime() >= since.getTime())
    .map((p) => p.ProcessId);
}

/**
 * Closes the hidden Office a timed-out or stopped command started (seen live: a hidden Word waited for an answer nobody
 * could give, and stayed after its command was killed). Windows only; never throws.
 */
export function closeOfficeLeftovers(since: Date): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(WINWORD|EXCEL|POWERPNT|MSACCESS|MSPUB|VISIO|OUTLOOK|ONENOTE|WINPROJ)\\.EXE$' } | " +
    "Select-Object ProcessId, Name, CommandLine, @{ n = 'Created'; e = { $_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000 }, (err, out) => {
      if (!err && String(out).trim()) {
        try {
          const parsed = JSON.parse(String(out)) as ProcessInfo | ProcessInfo[];
          for (const pid of officeLeftovers(Array.isArray(parsed) ? parsed : [parsed], since)) {
            try {
              process.kill(pid);
            } catch {
              // Already gone.
            }
          }
        } catch {
          // Nothing readable: nothing to close.
        }
      }
      resolve();
    });
  });
}
