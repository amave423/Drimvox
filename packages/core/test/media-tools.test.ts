import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/agent/workspace";
import { ffmpeg, runFfmpeg, setFfmpegSource } from "../src/tools/ffmpeg";
import { mediaTools } from "../src/tools/media";

// docs/specs/tools.md: audio and video in the folder, through ffmpeg (the computer's or a pinned download).
const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, { toolCallId: name, messages: [] });
const hooks = { onCall: () => {} };
let server: Server | undefined;
const dirs: string[] = [];
afterEach(async () => {
  setFfmpegSource(null);
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(null)));
  server = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

describe("ffmpeg's download", () => {
  async function serve(body: Buffer) {
    server = createServer((_req, res) => (res.writeHead(200), res.end(body)));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const platform = `${process.platform}-${process.arch}`;

  it("downloads the pinned build once, unpacked, when the computer has none", async () => {
    const binary = Buffer.from("not really ffmpeg");
    const gz = gzipSync(binary);
    const base = await serve(gz);
    setFfmpegSource({ base, builds: { [platform]: { file: "ff.gz", sha256: createHash("sha256").update(gz).digest("hex") } } });
    const data = temp("drimvox-ff-");
    const exe = await ffmpeg(data);
    expect(exe.startsWith(join(data, "ffmpeg"))).toBe(true);
    expect(readFileSync(exe)).toEqual(binary);
  });

  it("refuses a download that does not match its checksum", async () => {
    const base = await serve(gzipSync(Buffer.from("tampered")));
    setFfmpegSource({ base, builds: { [platform]: { file: "ff.gz", sha256: "0".repeat(64) } } });
    await expect(ffmpeg(temp("drimvox-ff-"))).rejects.toThrow(/checksum/);
  });
});

// The real pinned build, downloaded once into a cache outside the repository; skipped offline.
describe("media tools with the real ffmpeg", () => {
  const cache = join(tmpdir(), "drimvox-test-ffmpeg");
  it("tells what is inside, cuts, takes a frame and the sound, shrinks and joins", { timeout: 600_000 }, async () => {
    mkdirSync(cache, { recursive: true });
    let exe: string;
    try {
      exe = await ffmpeg(cache);
    } catch (err) {
      if (/fetch failed|ENOTFOUND|could not be downloaded/i.test(String(err))) return;
      throw err;
    }
    const folder = temp("drimvox-media-");
    // A 4-second test clip with sound, made by ffmpeg itself.
    const made = await runFfmpeg(exe, ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "4", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", join(folder, "clip.mp4")]);
    expect(made.code, made.log).toBe(0);
    const tools = mediaTools(cache, new Workspace(folder), hooks);
    const info = await call(tools, "media_edit", { action: "info", input: "clip.mp4" });
    expect(info).toMatch(/Duration: 00:00:04/);
    expect(info).toMatch(/Video: h264/);
    expect(await call(tools, "media_edit", { action: "trim", input: "clip.mp4", start: "00:00:01", end: "00:00:03", output: "out/cut.mp4" })).toMatch(/^Saved out\/cut\.mp4/);
    expect(await call(tools, "media_edit", { action: "frame", input: "clip.mp4", at: "00:00:02", output: "frame.png", width: 160 })).toMatch(/^Saved frame\.png/);
    expect(readFileSync(join(folder, "frame.png")).subarray(1, 4).toString()).toBe("PNG");
    expect(await call(tools, "media_edit", { action: "audio", input: "clip.mp4", output: "sound.mp3" })).toMatch(/^Saved sound\.mp3/);
    expect(await call(tools, "media_edit", { action: "compress", input: "clip.mp4", output: "small.mp4", width: 160 })).toMatch(/^Saved small\.mp4/);
    expect(await call(tools, "media_edit", { action: "join", input: "clip.mp4", inputs: ["clip.mp4", "out/cut.mp4"], output: "both.mp4" })).toMatch(/^Saved both\.mp4/);
    expect(existsSync(join(folder, "both.mp4"))).toBe(true);
    expect(await call(tools, "media_edit", { action: "info", input: "missing.mp4" })).toMatch(/No file/);
    // Speech needs a downloaded speech model; without the engine it says so.
    expect(await call(tools, "transcribe_media", { path: "clip.mp4" })).toMatch(/speech engine|speech model/);
  });
});
