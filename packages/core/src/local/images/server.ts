import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname } from "node:path";
import type { ImageFileRole, ImageSettings } from "./catalog";

/** Loading a model of several gigabytes into memory takes a while; longer than this means it will not start. */
const START_MS = 10 * 60_000;
/** A picture on the processor, or a clip on a home video card, can take long; this is the limit. */
const DRAW_MS = 2 * 60 * 60_000;
const POLL_MS = 400;

/** A failure of the engine, said to the user as it is. */
export class EngineError extends Error {}

/** The server's option for each kind of file. */
const OPTION: Record<ImageFileRole, string> = { diffusion: "--diffusion-model", vae: "--vae", llm: "--llm", t5xxl: "--t5xxl" };

export interface Loaded {
  model: string;
  files: Partial<Record<ImageFileRole, string>>;
  settings: ImageSettings;
  /** The model does not fit in video memory: weights wait in main memory until needed. */
  offload: boolean;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** One running `sd-server` with one model's files. */
export class ImageServer {
  private child: ChildProcess | null = null;
  private port = 0;
  /** The last lines it printed: what it says when it cannot start. */
  private tail: string[] = [];

  constructor(
    readonly loaded: Loaded,
    private readonly command: string[],
    private readonly env: Record<string, string>,
  ) {}

  get running(): boolean {
    return !!this.child;
  }

  async start(): Promise<void> {
    this.port = await freePort();
    const { files, settings, offload } = this.loaded;
    const [file, ...pre] = this.command;
    const args = [
      ...pre,
      ...Object.entries(files).flatMap(([role, path]) => [OPTION[role as ImageFileRole], path!]),
      "--listen-ip", "127.0.0.1",
      "--listen-port", String(this.port),
      "--cfg-scale", String(settings.cfg),
      ...(offload ? ["--offload-to-cpu"] : []),
    ];
    // Linux and macOS builds keep their libraries beside the program.
    const libs = dirname(file!);
    const child = spawn(file!, args, {
      env: { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"), DYLD_LIBRARY_PATH: libs, ...this.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const keep = (chunk: Buffer) => {
      this.tail.push(...chunk.toString("utf8").split(/\r?\n/).filter((l) => l.trim()));
      this.tail = this.tail.slice(-20);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    let failed: Error | null = null;
    child.on("error", (err) => (failed = err));
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });
    this.child = child;
    const until = Date.now() + START_MS;
    while (Date.now() < until) {
      if (failed) throw new EngineError(`The engine did not start: ${(failed as Error).message}`);
      if (this.child !== child) throw new EngineError(`The engine stopped while loading the model${this.said()}`);
      if (await this.answers()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    this.stop();
    throw new EngineError("The engine took too long to load the model");
  }

  private said(): string {
    const last = this.tail.filter((l) => /error|fail|out of memory|cannot|unable/i.test(l)).at(-1) ?? this.tail.at(-1);
    return last ? `: ${last.slice(0, 300)}` : "";
  }

  private async answers(): Promise<boolean> {
    try {
      return (await fetch(this.url("/sdcpp/v1/capabilities"), { signal: AbortSignal.timeout(2_000) })).ok;
    } catch {
      return false;
    }
  }

  private url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  private sampling() {
    const { settings } = this.loaded;
    return {
      ...(settings.negative ? { negative_prompt: settings.negative } : {}),
      sample_params: {
        sample_steps: settings.steps,
        ...(settings.sampler ? { sample_method: settings.sampler } : {}),
        ...(settings.flowShift !== undefined ? { flow_shift: settings.flowShift } : {}),
        guidance: { txt_cfg: settings.cfg },
      },
    };
  }

  /** Draws one picture; resolves with its PNG. */
  async draw(prompt: string, width: number, height: number, signal: AbortSignal): Promise<Buffer> {
    const job = await this.submit("img_gen", { prompt, width, height, seed: -1, batch_count: 1, output_format: "png", ...this.sampling() }, signal);
    const b64 = (job.result as { images?: { b64_json?: string }[] } | null)?.images?.[0]?.b64_json;
    if (!b64) throw new EngineError("The engine sent no picture");
    return Buffer.from(b64, "base64");
  }

  /** Films one clip of `seconds` at the model's own frame rate; resolves with the file and its type. */
  async film(prompt: string, width: number, height: number, seconds: number, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
    const fps = this.loaded.settings.fps ?? 16;
    // Wan takes 4n+1 frames.
    const frames = Math.round((fps * seconds) / 4) * 4 + 1;
    const job = await this.submit("vid_gen", { prompt, width, height, seed: -1, video_frames: frames, fps, output_format: "webm", ...this.sampling() }, signal);
    const result = job.result as { b64_json?: string; mime_type?: string } | null;
    if (!result?.b64_json) throw new EngineError("The engine sent no clip");
    return { bytes: Buffer.from(result.b64_json, "base64"), mime: result.mime_type ?? "video/webm" };
  }

  /** Puts a job to the engine and waits for it to finish. */
  private async submit(kind: "img_gen" | "vid_gen", body: object, signal: AbortSignal): Promise<{ result: unknown }> {
    const res = await fetch(this.url(`/sdcpp/v1/${kind}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new EngineError(`The engine refused the job: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const { id } = (await res.json()) as { id: string };
    const until = Date.now() + DRAW_MS;
    try {
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        signal.throwIfAborted();
        if (!this.child) throw new EngineError(`The engine stopped while drawing${this.said()}`);
        const job = (await (await fetch(this.url(`/sdcpp/v1/jobs/${id}`), { signal })).json()) as {
          status: string;
          result?: unknown;
          error?: { message?: string } | string | null;
        };
        if (job.status === "completed") return { result: job.result ?? null };
        if (job.status === "failed" || job.status === "cancelled") {
          const message = typeof job.error === "string" ? job.error : job.error?.message;
          throw new EngineError(message || `The job ${job.status}`);
        }
      }
      throw new EngineError("The job took too long");
    } catch (err) {
      if (signal.aborted) void fetch(this.url(`/sdcpp/v1/jobs/${id}/cancel`), { method: "POST" }).catch(() => {});
      throw err;
    }
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}
