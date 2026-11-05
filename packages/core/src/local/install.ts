import type { OllamaInstall } from "@drimvox/shared";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { removeTree } from "../fsx";
import { findProgram } from "./archive";

/**
 * Ollama as a plain program, from its GitHub releases, for this computer; null where Drimvox does not download it
 * (Linux: a server installs it as a service with its own script). Asked for: the official setup installed a whole app
 * of its own, with a tray icon and a sign-in; the plain build has neither.
 */
export function ollamaArchive(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform === "win32") return arch === "arm64" ? "ollama-windows-arm64.zip" : "ollama-windows-amd64.zip";
  if (platform === "darwin") return "ollama-darwin.tgz";
  return null;
}

export const OLLAMA_RELEASES = "https://github.com/ollama/ollama/releases/latest/download";
export const OLLAMA_LINUX_COMMAND = "curl -fsSL https://ollama.com/install.sh | sh";

export interface InstallerOptions {
  /** The archive's address; its sha256 is looked up in sha256sum.txt beside it. */
  url: string;
  /** Where Ollama is unpacked: a folder of the app's data, apart from any Ollama the user installed. */
  dir: string;
  /** Unpacks the archive into a folder; the system's tar by default. */
  unpack(archive: string, into: string): Promise<void>;
  /** Whether Ollama is on this computer now (and takes it up). */
  found(): boolean;
}

/** tar unpacks both: zip on Windows (bsdtar, there since Windows 10), tgz on a Mac. From disk, never whole in memory. */
export function unpackWithTar(archive: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  return new Promise((resolve, reject) =>
    // Windows' own tar by its full path: the git Drimvox carries puts GNU tar first on PATH, which opens no zip and
    // takes "C:" for a remote host (seen in the tests).
    execFile(
      process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar",
      ["-xf", archive, "-C", into],
      { windowsHide: true, maxBuffer: 1 << 20 },
      (err) => (err ? reject(err) : resolve()),
    ),
  );
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Installs Ollama from Drimvox (docs/specs/local-models.md): the user sees the size first, then the download's progress;
 * the archive is checked against Ollama's own checksums, unpacked into the app's data, and run by Drimvox when needed.
 */
export class OllamaInstaller {
  private current: OllamaInstall = { state: "idle", received: 0, total: null, error: null };

  constructor(private readonly o: InstallerOptions) {}

  state(): OllamaInstall {
    return { ...this.current };
  }

  /** The archive's size in bytes, asked of the server; null when it does not say. */
  async size(): Promise<number | null> {
    try {
      const res = await fetch(this.o.url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) });
      const length = Number(res.headers.get("content-length"));
      return res.ok && length > 0 ? length : null;
    } catch {
      return null;
    }
  }

  /** Starts the download and the unpacking; a second call while one runs does nothing. */
  start(): void {
    if (this.current.state === "downloading" || this.current.state === "installing") return;
    this.current = { state: "downloading", received: 0, total: null, error: null };
    void this.install().catch((err: unknown) => {
      this.current = { ...this.current, state: "failed", error: err instanceof Error && err.message === "not_found" ? "not_found" : "download" };
    });
  }

  private async install(): Promise<void> {
    const res = await fetch(this.o.url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error("download");
    const total = Number(res.headers.get("content-length"));
    this.current.total = total > 0 ? total : null;
    mkdirSync(dirname(this.o.dir), { recursive: true });
    const archive = `${this.o.dir}.${basename(new URL(this.o.url).pathname).replace(/^ollama-/, "")}`;
    // Straight to disk: a 1.5 GB archive is never held in memory (seen with models: the core fell over).
    const body = Readable.fromWeb(res.body as never);
    body.on("data", (chunk: Buffer) => (this.current.received += chunk.length));
    await pipeline(body, createWriteStream(archive));
    const expected = await this.checksum();
    if (expected && (await sha256Of(archive)) !== expected) {
      removeTree(archive);
      throw new Error("download");
    }
    this.current.state = "installing";
    const temp = `${this.o.dir}.unpacking`;
    removeTree(temp);
    await this.o.unpack(archive, temp);
    removeTree(this.o.dir);
    renameSync(temp, this.o.dir);
    removeTree(archive);
    if (!this.o.found()) throw new Error("not_found");
    this.current.state = "done";
  }

  /** The archive's sha256 from sha256sum.txt beside it; null when that list is not there. */
  private async checksum(): Promise<string | null> {
    try {
      const url = new URL(this.o.url);
      const name = basename(url.pathname);
      const res = await fetch(new URL("sha256sum.txt", url), { redirect: "follow", signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return null;
      const line = (await res.text()).split(/\r?\n/).find((l) => l.trim().endsWith(name));
      return line?.trim().split(/\s+/)[0]?.toLowerCase() ?? null;
    } catch {
      return null;
    }
  }
}

/** The program in Drimvox's own Ollama folder, if it was unpacked there, wherever the archive put it. */
export function ownOllama(dir: string): string[] | null {
  const program = findProgram(dir, [process.platform === "win32" ? "ollama.exe" : "ollama"]);
  return program ? [program] : null;
}
