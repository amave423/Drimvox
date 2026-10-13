import type { LocalHardware } from "@artel/shared";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { arch, platform, totalmem } from "node:os";
import { join } from "node:path";

type Gpu = NonNullable<LocalHardware["gpu"]>;

const run = (file: string, args: string[]) =>
  new Promise<string>((resolve) =>
    execFile(file, args, { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout.toString())),
  );

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: one card per line, memory in MiB. */
export function parseNvidiaSmi(out: string): Gpu | null {
  const cards = out
    .split(/\r?\n/)
    .map((l) => l.match(/^(.+?),\s*(\d+)\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ name: m[1]!.trim(), vramBytes: Number(m[2]) * 2 ** 20 }));
  return largest(cards);
}

/**
 * Video cards from the Windows driver registry as PowerShell's JSON: one object or a list of
 * { DriverDesc, VRAM }. Unlike WMI it is not capped at 4 GB.
 */
export function parseWindowsVideo(out: string): Gpu | null {
  if (!out.trim()) return null;
  try {
    const parsed = JSON.parse(out) as unknown;
    const items = (Array.isArray(parsed) ? parsed : [parsed]) as { DriverDesc?: unknown; VRAM?: unknown }[];
    return largest(
      items.filter((i) => typeof i.DriverDesc === "string" && typeof i.VRAM === "number" && i.VRAM > 0).map((i) => ({ name: i.DriverDesc as string, vramBytes: i.VRAM as number })),
    );
  } catch {
    return null;
  }
}

function largest(cards: Gpu[]): Gpu | null {
  return cards.reduce<Gpu | null>((best, c) => (!best || c.vramBytes > best.vramBytes ? c : best), null);
}

const WINDOWS_VIDEO =
  "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | " +
  "Select-Object DriverDesc, @{n='VRAM';e={[int64]$_.'HardwareInformation.qwMemorySize'}} | ConvertTo-Json -Compress";

/** AMD cards on Linux report their memory in /sys. */
function linuxAmd(): Gpu | null {
  try {
    const cards = readdirSync("/sys/class/drm")
      .filter((d) => /^card\d+$/.test(d))
      .flatMap((d) => {
        try {
          return [{ name: "AMD", vramBytes: Number(readFileSync(join("/sys/class/drm", d, "device", "mem_info_vram_total"), "utf8").trim()) }];
        } catch {
          return [];
        }
      });
    return largest(cards.filter((c) => c.vramBytes > 0));
  } catch {
    return null;
  }
}

let cached: Promise<LocalHardware> | null = null;

/** The computer's memory and its largest video card, looked up once. */
export function detectHardware(): Promise<LocalHardware> {
  cached ??= (async () => {
    const ramBytes = totalmem();
    if (platform() === "darwin" && arch() === "arm64") return { ramBytes, gpu: null, unified: true };
    let gpu = parseNvidiaSmi(await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]));
    if (!gpu && platform() === "win32") gpu = parseWindowsVideo(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_VIDEO]));
    if (!gpu && platform() === "linux") gpu = linuxAmd();
    return { ramBytes, gpu, unified: false };
  })();
  return cached;
}
