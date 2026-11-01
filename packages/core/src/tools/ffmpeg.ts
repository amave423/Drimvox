import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * ffmpeg for the media tools (docs/specs/tools.md): the computer's own when it has one, else a pinned static build
 * (eugeneware/ffmpeg-static b6.1.1, ffmpeg 6.1.1) downloaded once into the data folder and checked by its SHA-256.
 */
const BASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";
const BUILDS: Record<string, { file: string; sha256: string }> = {
  "win32-x64": { file: "ffmpeg-win32-x64.gz", sha256: "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77" },
  "linux-x64": { file: "ffmpeg-linux-x64.gz", sha256: "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa" },
  "darwin-arm64": { file: "ffmpeg-darwin-arm64.gz", sha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa" },
  "darwin-x64": { file: "ffmpeg-darwin-x64.gz", sha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106" },
};

let found: Promise<string> | null = null;

/** Tests: a fake build and where it comes from. */
let source: { base: string; builds?: typeof BUILDS } = { base: BASE };
export function setFfmpegSource(next: { base: string; builds?: typeof BUILDS } | null): void {
  source = next ?? { base: BASE };
  found = null;
}

function onPath(): Promise<string | null> {
  return new Promise((resolve) => execFile("ffmpeg", ["-version"], { windowsHide: true, timeout: 10_000 }, (err) => resolve(err ? null : "ffmpeg")));
}

/** The ffmpeg to run: the computer's, or Drimvox's own, downloaded the first time. */
export function ffmpeg(dataDir: string): Promise<string> {
  found ??= (async () => {
    if (!source.builds && (await onPath())) return "ffmpeg";
    const dir = join(dataDir, "ffmpeg");
    const exe = join(dir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    if (existsSync(exe)) return exe;
    const build = (source.builds ?? BUILDS)[`${process.platform}-${process.arch}`];
    if (!build) throw new Error(`No ffmpeg build for ${process.platform}-${process.arch}: install ffmpeg and try again.`);
    const res = await fetch(`${source.base}/${build.file}`, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`ffmpeg could not be downloaded (${res.status})`);
    const gz = Buffer.from(await res.arrayBuffer());
    if (createHash("sha256").update(gz).digest("hex") !== build.sha256) throw new Error("The downloaded ffmpeg did not match its checksum: refused.");
    mkdirSync(dir, { recursive: true });
    const part = `${exe}.part`;
    writeFileSync(part, gunzipSync(gz));
    if (process.platform !== "win32") chmodSync(part, 0o755);
    renameSync(part, exe);
    return exe;
  })().catch((err) => {
    found = null;
    throw err;
  });
  return found;
}

/** Runs ffmpeg; its own messages (on stderr) come back for the report. */
export function runFfmpeg(exe: string, args: string[], timeoutMs = 30 * 60_000, signal?: AbortSignal): Promise<{ code: number; log: string }> {
  return new Promise((resolve) => {
    execFile(exe, ["-hide_banner", ...args], { windowsHide: true, timeout: timeoutMs, signal, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, log: `${stdout}${stderr}` });
    });
  });
}

export function removeFfmpeg(dataDir: string): void {
  rmSync(join(dataDir, "ffmpeg"), { recursive: true, force: true });
  found = null;
}
