import { gunzipSync, unzipSync } from "fflate";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { Readable } from "node:stream";
import { removeTree } from "../fsx";

/**
 * Engines Drimvox downloads as a release archive (whisper.cpp, Piper): fetched with progress, unpacked next to the
 * folder and moved into place only once whole, so a half-unpacked engine never counts.
 */

/** A program in an unpacked archive, wherever the archive put it; null when there is none. */
export function findProgram(dir: string, names: string[]): string | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (names.includes(name) && statSync(path).isFile()) return path;
    if (statSync(path).isDirectory()) {
      const inner = findProgram(path, names);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * The files of a .tar archive (plain ustar, as GitHub's releases make them). A symbolic link becomes a copy of what it
 * points to: Piper's Linux build links its libraries (libonnxruntime.so → libonnxruntime.so.1.14.1).
 */
export function untar(bytes: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const links: [string, string][] = [];
  const text = (at: number, length: number) => new TextDecoder().decode(bytes.subarray(at, at + length)).replace(/\0.*$/s, "");
  for (let at = 0; at + 512 <= bytes.length; ) {
    const name = text(at, 100);
    if (!name) break;
    const size = parseInt(text(at + 124, 12).trim() || "0", 8);
    const type = text(at + 156, 1);
    const prefix = text(at + 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    if (type === "0" || type === "") files[path] = bytes.slice(at + 512, at + 512 + size);
    if (type === "2" || type === "1") links.push([path, text(at + 157, 100)]);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  for (const [path, target] of links) {
    const resolved = target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(posix.dirname(path), target));
    const found = files[resolved] ?? files[target];
    if (found) files[path] = found;
  }
  return files;
}

/** Downloads an engine's archive and unpacks it into `dir`; resolves with the program found in it. */
export async function installArchive(o: {
  url: string;
  dir: string;
  programs: string[];
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
  const archive = new Uint8Array(Buffer.concat(chunks));
  const files = o.url.endsWith(".tar.gz") ? untar(gunzipSync(archive)) : unzipSync(archive);
  const temp = `${o.dir}.unpacking`;
  removeTree(temp);
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    const path = join(temp, name);
    if (!path.startsWith(temp)) throw new Error(`The engine's archive has a bad path: ${name}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const program = findProgram(temp, o.programs);
  if (!program) throw new Error(`The engine's archive has no ${o.programs[0]}`);
  if (process.platform !== "win32") chmodSync(program, 0o755);
  mkdirSync(dirname(o.dir), { recursive: true });
  renameSync(temp, o.dir);
  return findProgram(o.dir, o.programs)!;
}
