import type { OllamaInstall } from "@drimvox/shared";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Ollama's official Windows setup; on Linux its own script, which needs the administrator's rights, is shown instead. */
export const OLLAMA_SETUP_URL = "https://ollama.com/download/OllamaSetup.exe";
export const OLLAMA_LINUX_COMMAND = "curl -fsSL https://ollama.com/install.sh | sh";

export interface InstallerOptions {
  url: string;
  /** Where the setup is saved. */
  dir: string;
  /** Runs the setup and resolves when it has finished. */
  run(file: string): Promise<void>;
  /** Whether Ollama is on this computer now. */
  found(): boolean;
}

/** Runs Ollama's setup quietly: it installs for this user, no administrator needed. */
export function runSetup(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { windowsHide: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`setup exited with ${code}`))));
  });
}

/**
 * Installs Ollama from Drimvox (docs/specs/local-models.md): the user sees the size first, then the download's progress;
 * the official setup runs quietly, and Drimvox picks Ollama up when it is there.
 */
export class OllamaInstaller {
  private current: OllamaInstall = { state: "idle", received: 0, total: null, error: null };

  constructor(private readonly o: InstallerOptions) {}

  state(): OllamaInstall {
    return { ...this.current };
  }

  /** The setup's size in bytes, asked of the server; null when it does not say. */
  async size(): Promise<number | null> {
    try {
      const res = await fetch(this.o.url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
      const length = Number(res.headers.get("content-length"));
      return res.ok && length > 0 ? length : null;
    } catch {
      return null;
    }
  }

  /** Starts the download and the setup; a second call while one runs does nothing. */
  start(): void {
    if (this.current.state === "downloading" || this.current.state === "installing") return;
    this.current = { state: "downloading", received: 0, total: null, error: null };
    void this.install().catch((err: unknown) => {
      this.current = { ...this.current, state: "failed", error: err instanceof Error && err.message === "not_found" ? "not_found" : "download" };
    });
  }

  private async install(): Promise<void> {
    const res = await fetch(this.o.url);
    if (!res.ok || !res.body) throw new Error("download");
    const total = Number(res.headers.get("content-length"));
    this.current.total = total > 0 ? total : null;
    mkdirSync(this.o.dir, { recursive: true });
    const file = join(this.o.dir, "OllamaSetup.exe");
    const body = Readable.fromWeb(res.body as never);
    body.on("data", (chunk: Buffer) => (this.current.received += chunk.length));
    await pipeline(body, createWriteStream(file));
    this.current.state = "installing";
    await this.o.run(file);
    if (!this.o.found()) throw new Error("not_found");
    this.current.state = "done";
  }
}
