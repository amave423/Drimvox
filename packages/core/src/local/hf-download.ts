import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

/** Where GGUF files come from. Hugging Face redirects to its CDN, which some networks cannot reach (seen from Russia). */
export const HF_FILE_BASES = ["https://huggingface.co"];

/** One way to reach the files: straight, or through the proxy from the settings. */
export interface Route {
  label: string;
  fetch: typeof fetch;
}

export interface HfDownload {
  /** The model's name for Ollama, hf.co/<repo>:<quant>. */
  model: string;
  /** Hugging Face's API, which gives the file list with sha256 (always huggingface.co itself). */
  apiUrl: string;
  /** Where the bytes may come from, in order. */
  bases: string[];
  /** How to reach them, in order: straight first, then the proxy when one is set; the one that worked goes first next time. */
  routes: Route[];
  /** Ollama's API root. */
  ollamaUrl: string;
  /** Unfinished files stay here between pauses. */
  dir: string;
  signal: AbortSignal;
  progress(p: { status: string; completed: number; total: number }): void;
  /** The partial file this download writes, so a cancel can delete it. */
  partial(path: string): void;
}

/** A failure the page shows: a network that does not reach any address, a file that is not what Hugging Face says. */
export class HfDownloadError extends Error {}

const QUANT_TAIL = (quant: string) => new RegExp(`[-_.]${quant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.gguf$`, "i");
/** How long an address may take to start sending, and to go quiet in the middle, before the next one is tried. */
const START_MS = 20_000;
const STALL_MS = 45_000;

let preferred: string | null = null;

/** The file of hf.co/<repo>:<quant>: its path, size and sha256, as Hugging Face lists it. */
async function findFile(apiUrl: string, repo: string, quant: string, signal: AbortSignal): Promise<{ path: string; size: number; sha256: string }> {
  const res = await fetch(`${apiUrl}/api/models/${repo}/tree/main`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }).catch((err: unknown) => {
    throw new HfDownloadError(`Hugging Face did not answer: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!res.ok) throw new HfDownloadError(`Hugging Face answered ${res.status}`);
  const files = (await res.json()) as { type: string; path: string; size: number; lfs?: { oid?: string; size?: number } }[];
  const tail = QUANT_TAIL(quant);
  const file = files.find((f) => f.type === "file" && !f.path.includes("/") && tail.test(f.path) && !/mmproj|imatrix|-\d{5}-of-\d{5}/i.test(f.path));
  if (!file?.lfs?.oid) throw new HfDownloadError(`pull model manifest: file does not exist (${repo}:${quant})`);
  return { path: file.path, size: file.lfs.size ?? file.size, sha256: file.lfs.oid };
}

/** Appends the bytes from `start` on to `part`; resolves when the address sent everything. */
async function fetchInto(route: Route, url: string, part: string, start: number, total: number, d: FileDownload): Promise<void> {
  const attempt = new AbortController();
  const stop = () => attempt.abort();
  d.signal.addEventListener("abort", stop, { once: true });
  let timer = setTimeout(stop, START_MS);
  try {
    const res = await route.fetch(url, { headers: start > 0 ? { range: `bytes=${start}-` } : {}, signal: attempt.signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`answered ${res.status}`);
    // A server that ignores Range sends the whole file again: start over rather than glue it on.
    const from = res.status === 206 ? start : 0;
    const out = createWriteStream(part, { flags: from > 0 ? "a" : "w" });
    let done = from;
    try {
      for await (const chunk of Readable.fromWeb(res.body as never) as AsyncIterable<Buffer>) {
        clearTimeout(timer);
        timer = setTimeout(stop, STALL_MS);
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        done += chunk.length;
        d.progress({ status: "downloading", completed: done, total });
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (done < total) throw new Error(`stopped at ${done} of ${total} bytes`);
  } finally {
    clearTimeout(timer);
    d.signal.removeEventListener("abort", stop);
  }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** A file of a repository by its exact path, as Hugging Face lists it; folders are listed one at a time. */
export async function fileByPath(apiUrl: string, repo: string, path: string, signal: AbortSignal): Promise<{ path: string; size: number; sha256: string }> {
  const folder = path.includes("/") ? `/${path.slice(0, path.lastIndexOf("/"))}` : "";
  const res = await fetch(`${apiUrl}/api/models/${repo}/tree/main${folder}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }).catch((err: unknown) => {
    throw new HfDownloadError(`Hugging Face did not answer: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!res.ok) throw new HfDownloadError(`Hugging Face answered ${res.status}`);
  const files = (await res.json()) as { type: string; path: string; size: number; lfs?: { oid?: string; size?: number } }[];
  const file = files.find((f) => f.type === "file" && f.path === path);
  if (!file?.lfs?.oid) throw new HfDownloadError(`No such file on Hugging Face: ${repo}/${path}`);
  return { path: file.path, size: file.lfs.size ?? file.size, sha256: file.lfs.oid };
}

export type FileDownload = Omit<HfDownload, "model" | "ollamaUrl">;

/**
 * Downloads one file of a repository into `d.dir` as `<sha256>.part` and checks it; resolves with that path, or with
 * null when paused. Pausing aborts `signal` and keeps the partial file; the next call goes on with Range.
 */
export async function downloadFile(d: FileDownload, repo: string, file: { path: string; size: number; sha256: string }): Promise<string | null> {
  mkdirSync(d.dir, { recursive: true });
  const part = join(d.dir, `${file.sha256}.part`);
  d.partial(part);

  const have = () => (existsSync(part) ? statSync(part).size : 0);
  if (have() < file.size) {
    const tries = d.routes.flatMap((route) => d.bases.map((base) => ({ route, base, key: `${route.label}|${base}` })));
    const order = [...tries.filter((t) => t.key === preferred), ...tries.filter((t) => t.key !== preferred)];
    const failures: string[] = [];
    for (const t of order) {
      if (d.signal.aborted) return null;
      d.progress({ status: "downloading", completed: have(), total: file.size });
      try {
        await fetchInto(t.route, `${t.base}/${repo}/resolve/main/${file.path.split("/").map(encodeURIComponent).join("/")}`, part, have(), file.size, d);
        preferred = t.key;
        break;
      } catch (err) {
        if (d.signal.aborted) return null;
        failures.push(`${t.route.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (have() < file.size) {
      const hint = d.routes.length > 1 ? "" : " Set a proxy in the settings: Artel then downloads through it.";
      throw new HfDownloadError(`Hugging Face's file server did not answer (${failures.join("; ")}).${hint}`);
    }
  }

  d.progress({ status: "verifying sha256 digest", completed: file.size, total: file.size });
  if ((await sha256Of(part)) !== file.sha256) {
    unlinkSync(part);
    throw new HfDownloadError("The downloaded file does not match Hugging Face's checksum; it was deleted. Try again.");
  }
  return part;
}

/**
 * Downloads hf.co/<repo>:<quant> by Artel itself and makes an Ollama model of it (seen: Ollama's own pull could not
 * reach Hugging Face's CDN).
 */
export async function downloadHf(d: HfDownload): Promise<void> {
  const m = /^hf\.co\/([\w.-]+\/[\w.-]+):([\w.-]+)$/i.exec(d.model);
  if (!m) throw new HfDownloadError(`Not a Hugging Face model name: ${d.model}`);
  const [, repo, quant] = m as unknown as [string, string, string];
  d.progress({ status: "pulling manifest", completed: 0, total: 0 });
  const file = await findFile(d.apiUrl, repo, quant, d.signal);
  const part = await downloadFile(d, repo, file);
  if (!part) return;

  // Into Ollama: the file as a blob, then a model made from it (it reads the chat template from the GGUF).
  d.progress({ status: "copying the model to Ollama", completed: file.size, total: file.size });
  const digest = `sha256:${file.sha256}`;
  const known = await fetch(`${d.ollamaUrl}/api/blobs/${digest}`, { method: "HEAD", signal: d.signal });
  if (!known.ok) {
    const up = await fetch(`${d.ollamaUrl}/api/blobs/${digest}`, { method: "POST", body: Readable.toWeb(createReadStream(part)) as never, duplex: "half", signal: d.signal } as RequestInit);
    if (!up.ok) throw new HfDownloadError(`Ollama did not take the file: ${up.status}`);
  }
  const res = await fetch(`${d.ollamaUrl}/api/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: d.model, files: { [file.path]: digest }, stream: true }),
    signal: d.signal,
  });
  if (!res.ok || !res.body) throw new HfDownloadError(`Ollama answered ${res.status}`);
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { status?: string; error?: string });
  const failed = lines.find((l) => l.error);
  if (failed) throw new HfDownloadError(failed.error!);
  if (!lines.some((l) => l.status === "success")) throw new HfDownloadError("Ollama did not finish making the model");
  unlinkSync(part);
}
