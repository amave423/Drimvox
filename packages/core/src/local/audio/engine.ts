import { gunzipSync, unzipSync } from "fflate";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { removeTree } from "../../fsx";

/** The whisper.cpp build Drimvox uses (docs/specs/local-audio.md): pinned, a newer one changes nothing until checked. */
export const WHISPER_TAG = "b5130";
const RELEASES = "https://github.com/ggml-org/whisper.cpp/releases/download";

/** The processor build for Windows and Linux: it runs on any computer, and speech is quick enough without a video card. */
export function whisperUrl(platform: string = process.platform, arch: string = process.arch): string | null {
  const asset = platform === "win32" && arch === "x64" ? "whisper-bin-x64.zip" : platform === "linux" && arch === "x64" ? "whisper-bin-ubuntu-x64.tar.gz" : null;
  return asset ? `${RELEASES}/${WHISPER_TAG}/${asset}` : null;
}

const CLI = ["whisper-cli.exe", "whisper-cli"];

/** The command-line program in an unpacked engine, wherever the archive put it; null when there is none. */
export function findCli(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (CLI.includes(name)) return path;
    if (statSync(path).isDirectory()) {
      const inner = findCli(path);
      if (inner) return inner;
    }
  }
  return null;
}

/** The files of a .tar archive (plain ustar, as GitHub's releases make them). */
function untar(bytes: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const text = (at: number, length: number) => new TextDecoder().decode(bytes.subarray(at, at + length)).replace(/\0.*$/s, "");
  for (let at = 0; at + 512 <= bytes.length; ) {
    const name = text(at, 100);
    if (!name) break;
    const size = parseInt(text(at + 124, 12).trim() || "0", 8);
    const type = text(at + 156, 1);
    const prefix = text(at + 345, 155);
    if (type === "0" || type === "") files[prefix ? `${prefix}/${name}` : name] = bytes.slice(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Downloads the engine's archive and unpacks it into `dir`; resolves with the program. Half-unpacked never counts. */
export async function installWhisper(o: { url: string; dir: string; fetch: typeof fetch; signal: AbortSignal; progress(received: number, total: number): void }): Promise<string> {
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
  const cli = findCli(temp);
  if (!cli) throw new Error("The engine's archive has no whisper-cli");
  if (process.platform !== "win32") chmodSync(cli, 0o755);
  mkdirSync(dirname(o.dir), { recursive: true });
  renameSync(temp, o.dir);
  return findCli(o.dir)!;
}
