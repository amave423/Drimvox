import type { LocalHardware, LocalModel, LocalPull } from "@artel/shared";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { onPath } from "../cli/resolve";
import { GB } from "./fit";

/** How to start `ollama serve` here: the program on PATH or where its installer puts it. Null when it is not installed. */
export function findOllama(): string[] | null {
  const found = onPath("ollama")[0];
  if (found) return [found];
  const known =
    process.platform === "win32"
      ? [join(process.env.LOCALAPPDATA ?? "", "Programs", "Ollama", "ollama.exe")]
      : process.platform === "darwin"
        ? ["/Applications/Ollama.app/Contents/Resources/ollama", "/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"]
        : ["/usr/local/bin/ollama", "/usr/bin/ollama"];
  const file = known.find((f) => f && existsSync(f));
  return file ? [file] : null;
}

/** Ollama's default window makes a model forget a long conversation; Artel gives a bigger one when it starts Ollama itself. */
export function contextFor(hw: LocalHardware): number {
  const vram = hw.unified ? hw.ramBytes * 0.7 : (hw.gpu?.vramBytes ?? 0);
  return vram >= 24 * GB ? 32_768 : 16_384;
}

export interface OllamaOptions {
  /** Ollama's own API root, such as http://127.0.0.1:11434. */
  apiUrl: string;
  /** What starts `ollama serve` (Artel adds "serve"); null when Ollama is not installed. */
  command: string[] | null;
  /** Extra environment for it; tests pass their fake's settings. */
  commandEnv?: Record<string, string>;
  /** Without requests, downloads or loaded models for this long, the Ollama Artel started goes away. */
  idleMs: number;
  hardware: () => Promise<LocalHardware>;
  /** A download finished: the chat should see the new model. */
  onPulled?: () => void;
}

interface Active {
  pull: LocalPull;
  abort: AbortController;
  layers: Map<string, { total: number; completed: number }>;
  /** The last measure of progress, for the speed. */
  sample?: { at: number; completed: number };
}

/** How long Ollama gets to come up after Artel starts it. */
const START_MS = 30_000;

/**
 * The Ollama on this computer: started by Artel when needed and stopped when idle, unless the user runs it
 * themselves; downloads with progress. See docs/specs/local-models.md.
 */
export class OllamaManager {
  private child: ChildProcess | null = null;
  private starting: Promise<boolean> | null = null;
  private lastUse = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly pulls = new Map<string, Active>();
  private closed = false;

  constructor(private readonly o: OllamaOptions) {}

  /** Ollama was installed while Artel ran: from now on Artel starts this program. */
  setCommand(command: string[]): void {
    this.o.command = command;
  }

  /** Whether a provider's address is this Ollama: then its requests wake it up. */
  handles(baseUrl: string): boolean {
    const norm = (url: string) => {
      try {
        const u = new URL(url);
        const host = u.hostname === "localhost" || u.hostname === "[::1]" ? "127.0.0.1" : u.hostname;
        return `${host}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
      } catch {
        return "";
      }
    };
    return norm(baseUrl) !== "" && norm(baseUrl) === norm(this.o.apiUrl);
  }

  /** Something is using Ollama: the idle clock starts over. */
  touch(): void {
    this.lastUse = Date.now();
  }

  private async call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs = 10_000, ...rest } = init;
    return fetch(`${this.o.apiUrl}${path}`, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
  }

  private async version(): Promise<string | null> {
    try {
      const res = await this.call("/api/version", { timeoutMs: 1_500 });
      return res.ok ? (((await res.json()) as { version?: string }).version ?? "") : null;
    } catch {
      return null;
    }
  }

  /** Ollama answers, starting it first when it is installed and quiet. False when it cannot be had. */
  async ensureRunning(): Promise<boolean> {
    this.touch();
    if (this.closed) return false;
    if ((await this.version()) !== null) return true;
    if (!this.o.command) return false;
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<boolean> {
    const [file, ...args] = this.o.command!;
    const host = new URL(this.o.apiUrl).host;
    const child = spawn(file!, [...args, "serve"], {
      env: { ...process.env, ...this.o.commandEnv, OLLAMA_HOST: host, OLLAMA_CONTEXT_LENGTH: String(contextFor(await this.o.hardware())) },
      stdio: "ignore",
      windowsHide: true,
    });
    // A program that cannot start (a wrong path) gives an error and no exit: the wait must end on it too.
    child.on("error", () => {
      if (this.child === child) this.child = null;
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });
    this.child = child;
    const until = Date.now() + START_MS;
    while (Date.now() < until && this.child === child) {
      if ((await this.version()) !== null) {
        this.watchIdle();
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.child === child) this.stop();
    return false;
  }

  /** Checks now and then whether the Ollama Artel started may go. */
  private watchIdle(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.idleCheck(), Math.max(50, Math.min(this.o.idleMs / 4, 30_000)));
    this.timer.unref?.();
  }

  private async idleCheck(): Promise<void> {
    if (!this.child) return this.stopWatching();
    if (this.pulls.size > [...this.pulls.values()].filter((a) => a.pull.done).length) return this.touch();
    if (Date.now() - this.lastUse < this.o.idleMs) return;
    // A model still in memory is still in use: Ollama unloads it after its own keep-alive.
    try {
      const res = await this.call("/api/ps", { timeoutMs: 2_000 });
      const loaded = res.ok ? (((await res.json()) as { models?: unknown[] }).models ?? []) : [];
      if (loaded.length > 0) return;
    } catch {
      // Not answering any more: nothing to keep.
    }
    if (Date.now() - this.lastUse >= this.o.idleMs) this.stop();
  }

  private stopWatching(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stops the Ollama Artel started; one the user started is left alone. */
  stop(): void {
    this.stopWatching();
    const child = this.child;
    this.child = null;
    child?.kill();
  }

  async status(): Promise<{ installed: boolean; running: boolean; managed: boolean; version: string | null; models: LocalModel[]; pulls: LocalPull[] }> {
    const running = await this.ensureRunning();
    const version = running ? await this.version() : null;
    return {
      installed: !!this.o.command || version !== null,
      running: version !== null,
      managed: !!this.child,
      version,
      models: version !== null ? await this.models() : [],
      pulls: [...this.pulls.values()].map((a) => ({ ...a.pull })),
    };
  }

  async models(): Promise<LocalModel[]> {
    try {
      const res = await this.call("/api/tags");
      if (!res.ok) return [];
      const body = (await res.json()) as { models?: { name: string; size?: number; modified_at?: string }[] };
      return (body.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size ?? 0, modifiedAt: m.modified_at ?? "" }));
    } catch {
      return [];
    }
  }

  /** Starts a download, or returns the one already going. Progress shows in the status. */
  async pull(model: string): Promise<LocalPull> {
    const going = this.pulls.get(model);
    if (going && !going.pull.done && !going.pull.paused) return { ...going.pull };
    // A paused download goes on: Ollama keeps what it has and fetches the rest.
    const before = going?.pull.paused ? going.pull : null;
    const active: Active = {
      pull: { model, status: "starting", completed: before?.completed ?? 0, total: before?.total ?? 0, done: false, error: null, paused: false, bytesPerSecond: null },
      abort: new AbortController(),
      layers: new Map(),
    };
    this.pulls.set(model, active);
    if (!(await this.ensureRunning())) {
      Object.assign(active.pull, { done: true, error: "Ollama is not running" });
      return { ...active.pull };
    }
    void this.download(active);
    return { ...active.pull };
  }

  private async download(a: Active): Promise<void> {
    const p = a.pull;
    try {
      const res = await fetch(`${this.o.apiUrl}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: p.model, stream: true }),
        signal: a.abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Ollama answered ${res.status}`);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        this.touch();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) this.progress(a, JSON.parse(line) as Record<string, unknown>);
      }
      if (buffer.trim()) this.progress(a, JSON.parse(buffer) as Record<string, unknown>);
      if (!p.done) Object.assign(p, { done: true, error: p.error ?? "Ollama stopped the download" });
    } catch (err) {
      if (a.abort.signal.aborted) return;
      Object.assign(p, { done: true, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.touch();
    }
  }

  private progress(a: Active, line: Record<string, unknown>): void {
    const p = a.pull;
    if (typeof line.error === "string") {
      Object.assign(p, { done: true, error: line.error });
      return;
    }
    if (typeof line.status === "string") p.status = line.status;
    if (typeof line.digest === "string" && typeof line.total === "number") {
      a.layers.set(line.digest, { total: line.total, completed: typeof line.completed === "number" ? line.completed : 0 });
      p.total = [...a.layers.values()].reduce((s, l) => s + l.total, 0);
      p.completed = [...a.layers.values()].reduce((s, l) => s + l.completed, 0);
      this.measure(a);
    }
    if (line.status === "success") {
      Object.assign(p, { done: true, error: null, completed: p.total });
      this.o.onPulled?.();
    }
  }

  /** The speed over the last second or so, smoothed: what the time left is told from. */
  private measure(a: Active): void {
    const now = Date.now();
    if (!a.sample) {
      a.sample = { at: now, completed: a.pull.completed };
      return;
    }
    const seconds = (now - a.sample.at) / 1000;
    if (seconds < 0.5) return;
    const rate = Math.max(0, (a.pull.completed - a.sample.completed) / seconds);
    a.pull.bytesPerSecond = a.pull.bytesPerSecond === null ? rate : a.pull.bytesPerSecond * 0.6 + rate * 0.4;
    a.sample = { at: now, completed: a.pull.completed };
  }

  /** Stops a download for now and keeps it listed; pulling the model again goes on where it stopped. */
  pause(model: string): boolean {
    const a = this.pulls.get(model);
    if (!a || a.pull.done) return false;
    a.abort.abort();
    Object.assign(a.pull, { paused: true, bytesPerSecond: null, status: "paused" });
    return true;
  }

  /** Stops a download, or forgets a finished one. False when there is no such download. */
  cancel(model: string): boolean {
    const a = this.pulls.get(model);
    if (!a) return false;
    a.abort.abort();
    this.pulls.delete(model);
    return true;
  }

  /** Deletes a downloaded model. False when Ollama does not have it. */
  async remove(model: string): Promise<boolean> {
    if (!(await this.ensureRunning())) return false;
    const res = await this.call("/api/delete", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
    return res.ok;
  }

  close(): void {
    this.closed = true;
    for (const a of this.pulls.values()) a.abort.abort();
    this.pulls.clear();
    this.stop();
  }
}
