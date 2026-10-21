import { unzipSync } from "fflate";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { removeTree } from "../../fsx";

/**
 * The engine's release Drimvox uses (docs/specs/local-images.md): pinned, so a new stable-diffusion.cpp changes
 * nothing until Drimvox itself is updated with it, checked.
 */
export const ENGINE_TAG = "master-975-95b3090";
const RELEASES = "https://github.com/leejet/stable-diffusion.cpp/releases/download";

/** The Vulkan build for Windows and Linux (any video card, or the processor), Metal on Apple Silicon. */
export function engineUrl(platform: string = process.platform, arch: string = process.arch): string | null {
  const build = ENGINE_TAG.replace(/^master-\d+-/, "");
  const asset =
    platform === "win32" && arch === "x64"
      ? `sd-master-${build}-bin-win-vulkan-x64.zip`
      : platform === "linux" && arch === "x64"
        ? `sd-master-${build}-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip`
        : platform === "darwin" && arch === "arm64"
          ? `sd-master-${build}-bin-Darwin-macOS-26.6.2-arm64.zip`
          : null;
  return asset ? `${RELEASES}/${ENGINE_TAG}/${asset}` : null;
}

const SERVER = process.platform === "win32" ? "sd-server.exe" : "sd-server";

/** The server program in an unpacked engine, wherever the archive put it; null when there is none. */
export function findServer(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === SERVER || name === "sd-server.exe" || name === "sd-server") return path;
    if (statSync(path).isDirectory()) {
      const inner = findServer(path);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * Downloads the engine's archive and unpacks it into `dir`; resolves with the server program. The archive is small
 * (tens of megabytes), so it is unpacked in memory; a half-unpacked folder never counts as the engine.
 */
export async function installEngine(o: {
  url: string;
  dir: string;
  fetch: typeof fetch;
  signal: AbortSignal;
  progress(received: number, total: number): void;
}): Promise<string> {
  const res = await o.fetch(o.url, { signal: o.signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`The engine's download answered ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of Readable.fromWeb(res.body as never) as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    received += chunk.length;
    o.progress(received, total);
  }
  const files = unzipSync(new Uint8Array(Buffer.concat(chunks)));
  // What an earlier, broken unpacking left (removeTree: Node's own recursive delete skips files under a Cyrillic path).
  const temp = `${o.dir}.unpacking`;
  removeTree(temp);
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    const path = join(temp, name);
    if (!path.startsWith(temp)) throw new Error(`The engine's archive has a bad path: ${name}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const server = findServer(temp);
  if (!server) throw new Error("The engine's archive has no sd-server");
  if (process.platform !== "win32") chmodSync(server, 0o755);
  mkdirSync(dirname(o.dir), { recursive: true });
  renameSync(temp, o.dir);
  return findServer(o.dir)!;
}
