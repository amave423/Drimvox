import type { LocalPull, LocalSpeechStatus, LocalVoiceId } from "@drimvox/shared";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchVia } from "../../proxy";
import { downloadFile, fileByPath, type Route } from "../hf-download";
import { VOICES, type VoiceDef } from "./catalog";
import { findPiper, installPiper, piperUrl } from "./engine";

export interface LocalSpeechOptions {
  /** The engine's archive; Drimvox's pinned build for this system by default, null where there is none. */
  engineUrl?: string | null;
  /** Tests: what runs instead of the downloaded piper. */
  command?: string[];
}

interface Deps {
  /** The speech folder: the engine and the voices. */
  dir: string;
  hf: { apiUrl: string; bases: string[]; dir: string; proxy(): string | null };
}

interface Active {
  pull: LocalPull;
  abort: AbortController;
  partial?: string;
}

/** A long answer is read in one go, within this time. */
const SPEAK_MS = 3 * 60_000;

/**
 * Reading answers aloud on this computer (docs/specs/local-speech.md, asked for: the system's voice sounded like a
 * robot): Piper and its voices, downloaded by Drimvox; a text becomes a WAV, free and without the internet.
 */
export class LocalSpeech {
  private readonly pulls = new Map<LocalVoiceId, Active>();
  private readonly url: string | null;

  constructor(
    private readonly d: Deps,
    private readonly o: LocalSpeechOptions = {},
  ) {
    this.url = o.engineUrl === undefined ? piperUrl() : o.engineUrl;
  }

  private get engineDir() {
    return join(this.d.dir, "engine");
  }

  private pathOf(v: VoiceDef) {
    return join(this.d.dir, "voices", `${v.id}.onnx`);
  }

  private installedVoice(v: VoiceDef): boolean {
    return existsSync(this.pathOf(v)) && existsSync(`${this.pathOf(v)}.json`);
  }

  status(): LocalSpeechStatus {
    return {
      supported: this.url !== null,
      engine: !!findPiper(this.engineDir),
      voices: VOICES.map((v) => ({ id: v.id, name: v.name, lang: v.lang, gender: v.gender, sizeBytes: v.bytes, installed: this.installedVoice(v), pull: this.pulls.get(v.id)?.pull ?? null })),
    };
  }

  pull(id: LocalVoiceId): LocalPull {
    if (this.url === null) throw new Error("There is no build of the engine for this system");
    const voice = VOICES.find((v) => v.id === id)!;
    const going = this.pulls.get(id);
    if (going && !going.pull.done && !going.pull.paused) return { ...going.pull };
    const a: Active = {
      pull: { model: id, status: "starting", completed: going?.pull.completed ?? 0, total: voice.bytes, done: false, error: null, paused: false, bytesPerSecond: null },
      abort: new AbortController(),
    };
    this.pulls.set(id, a);
    void this.download(a, voice);
    return { ...a.pull };
  }

  private routes(): Route[] {
    const proxy = this.d.hf.proxy();
    return [{ label: "direct", fetch }, ...(proxy ? [{ label: "proxy", fetch: fetchVia(proxy) }] : [])];
  }

  private async download(a: Active, voice: VoiceDef): Promise<void> {
    const p = a.pull;
    const signal = a.abort.signal;
    let sample = { at: Date.now(), completed: p.completed };
    const measure = () => {
      const seconds = (Date.now() - sample.at) / 1000;
      if (seconds < 0.5) return;
      const rate = Math.max(0, (p.completed - sample.completed) / seconds);
      p.bytesPerSecond = p.bytesPerSecond === null ? rate : p.bytesPerSecond * 0.6 + rate * 0.4;
      sample = { at: Date.now(), completed: p.completed };
    };
    try {
      p.status = "pulling manifest";
      const info = existsSync(this.pathOf(voice)) ? null : await fileByPath(this.d.hf.apiUrl, voice.repo, voice.path, signal);
      let engine = { got: 0, of: 0 };
      const recount = (inFile: number) => {
        p.completed = engine.got + inFile;
        p.total = engine.of + (info?.size ?? 0);
        measure();
      };
      if (!findPiper(this.engineDir)) {
        p.status = "downloading the engine";
        await installPiper({
          url: this.url!,
          dir: this.engineDir,
          fetch: this.routes()[0]!.fetch,
          signal,
          progress: (received, total) => {
            engine = { got: received, of: Math.max(total, received) };
            recount(0);
          },
        });
      }
      mkdirSync(join(this.d.dir, "voices"), { recursive: true });
      // The voice's settings: a small file next to the model, not kept in Hugging Face's large-file storage.
      if (!existsSync(`${this.pathOf(voice)}.json`)) {
        const res = await this.routes()[0]!.fetch(`${this.d.hf.bases[0]}/${voice.repo}/resolve/main/${voice.path}.json`, { signal, redirect: "follow" });
        if (!res.ok) throw new Error(`The voice's settings answered ${res.status}`);
        writeFileSync(`${this.pathOf(voice)}.json`, Buffer.from(await res.arrayBuffer()));
      }
      if (info) {
        p.status = "downloading";
        const part = await downloadFile(
          {
            apiUrl: this.d.hf.apiUrl,
            bases: this.d.hf.bases,
            routes: this.routes(),
            dir: this.d.hf.dir,
            signal,
            partial: (path) => (a.partial = path),
            progress: (s) => (s.status === "downloading" ? recount(s.completed) : (p.status = s.status)),
          },
          voice.repo,
          info,
        );
        if (!part) return;
        renameSync(part, this.pathOf(voice));
        a.partial = undefined;
      }
      Object.assign(p, { done: true, error: null, status: "success", completed: p.total, bytesPerSecond: null });
    } catch (err) {
      if (signal.aborted) return;
      Object.assign(p, { done: true, error: err instanceof Error ? err.message : String(err), bytesPerSecond: null });
    }
  }

  pause(id: LocalVoiceId): boolean {
    const a = this.pulls.get(id);
    if (!a || a.pull.done) return false;
    a.abort.abort();
    Object.assign(a.pull, { paused: true, bytesPerSecond: null, status: "paused" });
    return true;
  }

  cancel(id: LocalVoiceId): boolean {
    const a = this.pulls.get(id);
    if (!a) return false;
    a.abort.abort();
    this.pulls.delete(id);
    const file = a.partial;
    if (file) setTimeout(() => rmSync(file, { force: true }), 500).unref();
    return true;
  }

  remove(id: LocalVoiceId): boolean {
    const voice = VOICES.find((v) => v.id === id);
    if (!voice || !existsSync(this.pathOf(voice))) return false;
    rmSync(this.pathOf(voice), { force: true });
    rmSync(`${this.pathOf(voice)}.json`, { force: true });
    this.pulls.delete(id);
    return true;
  }

  /** Deletes the engine, the voices staying; refused while something downloads. */
  removeEngine(): boolean {
    if ([...this.pulls.values()].some((a) => !a.pull.done && !a.pull.paused)) return false;
    rmSync(this.engineDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    for (const [id, a] of this.pulls) if (a.pull.done) this.pulls.delete(id);
    return true;
  }

  /** A text read aloud by a downloaded voice, as a WAV. */
  async speak(id: string, text: string): Promise<Buffer> {
    const voice = VOICES.find((v) => v.id === id);
    if (!voice || !this.installedVoice(voice)) throw new Error("This voice is not downloaded");
    const program = this.o.command ?? [findPiper(this.engineDir) ?? ""];
    if (!program[0]) throw new Error("The speech engine is not downloaded");
    const out = join(tmpdir(), `drimvox-speech-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          program[0]!,
          [...program.slice(1), "--model", this.pathOf(voice), "--output_file", out],
          { timeout: SPEAK_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
          (err) => (err ? reject(err) : resolve()),
        );
        // The text goes in on standard input, as UTF-8: one sentence per line reads with natural pauses.
        child.stdin?.end(text.replace(/\s*\n+\s*/g, "\n"), "utf8");
      });
      return readFileSync(out);
    } finally {
      rmSync(out, { force: true });
    }
  }
}
