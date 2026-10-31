import { createHash } from "node:crypto";
import { gunzipSync, unzipSync } from "fflate";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { removeTree } from "../../fsx";

/**
 * The CLIProxyAPI release Drimvox uses (docs/specs/subscriptions.md): pinned with its checksums, so a new release
 * changes nothing until Drimvox itself is updated with it, checked.
 */
export const CLIPROXY_VERSION = "8.0.48";
const RELEASES = "https://github.com/router-for-me/CLIProxyAPI/releases/download";
/** SHA-256 of each archive, from the release's checksums.txt. */
const SHA256: Record<string, string> = {
  windows_amd64: "6806d1ff586a33da9a470d4b6f119d73dd00743c5282d62e7df4d32a2a2a6aef",
  windows_aarch64: "6f248b60e6e4d634ca4bc155e22e5392bcdca4e8eeb633f3cc9acad6766efa5e",
  linux_amd64: "095c46e7165842cf563f9665be86cf24a29ba94e57ab9bd67588fe5cc4c7125c",
  linux_aarch64: "9ed7c06aa96d9cc6736ddfc897de07b8b6085731785087f6701f07ec9ec198dd",
  darwin_amd64: "97f662d40bc3da1bd6bb0f9188ba803d11e0cb29dfc037376bb655bf3f437781",
  darwin_aarch64: "543bdbc6f8384fecd033bf7398236e46279962a80dbc909cf8d8e6ee94ccfc04",
};

/** The archive for this computer, with its checksum; null where there is no build. */
export function cliProxyAsset(platform: string = process.platform, arch: string = process.arch): { url: string; sha256: string } | null {
  const os = platform === "win32" ? "windows" : platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "aarch64" : null;
  if (!os || !cpu) return null;
  const key = `${os}_${cpu}`;
  const ext = os === "windows" ? "zip" : "tar.gz";
  return { url: `${RELEASES}/v${CLIPROXY_VERSION}/CLIProxyAPI_${CLIPROXY_VERSION}_${key}.${ext}`, sha256: SHA256[key]! };
}

export const PROGRAM = process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";

/** The files of a tar archive (ustar: 512-byte headers, the data padded to 512). */
export function untar(data: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const text = (from: number, len: number) => new TextDecoder().decode(data.subarray(from, from + len)).replace(/\0.*$/s, "");
  for (let at = 0; at + 512 <= data.length; ) {
    const name = text(at, 100);
    if (!name) break;
    const prefix = text(at + 345, 155);
    const size = parseInt(text(at + 124, 12).trim() || "0", 8);
    const type = text(at + 156, 1);
    const start = at + 512;
    if (type === "0" || type === "") files[prefix ? `${prefix}/${name}` : name] = data.subarray(start, start + size);
    at = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * Downloads the archive, checks its checksum and unpacks it into `dir`; resolves with the program's path. A
 * half-unpacked folder never counts as installed.
 */
export async function installCliProxy(o: {
  url: string;
  sha256: string;
  dir: string;
  fetch: typeof fetch;
  signal: AbortSignal;
  progress(received: number, total: number): void;
}): Promise<string> {
  const res = await o.fetch(o.url, { signal: o.signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`The download answered ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of Readable.fromWeb(res.body as never) as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    received += chunk.length;
    o.progress(received, total);
  }
  const archive = Buffer.concat(chunks);
  const hash = createHash("sha256").update(archive).digest("hex");
  if (hash !== o.sha256) throw new Error("The downloaded archive does not match its checksum");
  const files = o.url.endsWith(".zip") ? unzipSync(new Uint8Array(archive)) : untar(gunzipSync(new Uint8Array(archive)));
  const program = Object.keys(files).find((name) => name.split("/").pop() === PROGRAM || name.split("/").pop() === "cli-proxy-api");
  if (!program) throw new Error("The archive has no cli-proxy-api");
  const temp = `${o.dir}.unpacking`;
  removeTree(temp);
  mkdirSync(temp, { recursive: true });
  const target = join(temp, PROGRAM);
  writeFileSync(target, files[program]!);
  if (process.platform !== "win32") chmodSync(target, 0o755);
  // The account logins of an earlier install stay: they live next to it, not inside the program's folder.
  removeTree(o.dir);
  mkdirSync(dirname(o.dir), { recursive: true });
  renameSync(temp, o.dir);
  return join(o.dir, PROGRAM);
}

export function installedProgram(dir: string): string | null {
  const path = join(dir, PROGRAM);
  return existsSync(path) ? path : null;
}
