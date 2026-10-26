import { createReadStream, createWriteStream, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * A big file comes in several pieces at once, each over its own connection (seen: one connection, through a proxy, was
 * the limit on speed). Each piece goes on from where it broke; the pieces are joined into the partial file at the end.
 */
export const SEGMENTS = 6;
/** Smaller files are not worth splitting. */
export const SEGMENT_MIN = 32 * 1024 * 1024;

/** The server sent the whole file for a range: pieces cannot work there. */
export class NoRanges extends Error {}

export interface Way {
  key: string;
  fetch: typeof fetch;
  url: string;
}

export interface SegmentOptions {
  ways: Way[];
  part: string;
  size: number;
  pieces: number;
  signal: AbortSignal;
  startMs: number;
  stallMs: number;
  stalledRounds: number;
  retryMs: number;
  progress(completed: number): void;
  /** The way that worked, to try first next time. */
  worked(key: string): void;
}

const pieceFile = (part: string, i: number) => `${part}.${i}`;
const sizeOf = (file: string) => (existsSync(file) ? statSync(file).size : 0);

/** Deletes a partial download: the file and the pieces it may be in. */
export function removePartial(part: string): void {
  try {
    rmSync(part, { force: true });
    const dir = dirname(part);
    const base = `${basename(part)}.`;
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) if (f.startsWith(base) && /^\d+$/.test(f.slice(base.length))) rmSync(join(dir, f), { force: true });
  } catch {
    // Left for the next start to overwrite.
  }
}

/** Pieces already on disk from an earlier, paused download. */
export function hasPieces(part: string): boolean {
  return existsSync(pieceFile(part, 0));
}

/** One piece's range, inclusive. */
function rangeOf(i: number, pieces: number, size: number): [number, number] {
  return [Math.floor((size * i) / pieces), Math.floor((size * (i + 1)) / pieces) - 1];
}

async function fetchRange(way: Way, file: string, from: number, to: number, o: SegmentOptions, onBytes: (n: number) => void): Promise<void> {
  const attempt = new AbortController();
  const stop = () => attempt.abort();
  o.signal.addEventListener("abort", stop, { once: true });
  let timer = setTimeout(stop, o.startMs);
  try {
    const res = await way.fetch(way.url, { headers: { range: `bytes=${from}-${to}` }, signal: attempt.signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`answered ${res.status}`);
    if (res.status !== 206) {
      attempt.abort();
      throw new NoRanges("The file server does not send parts of files");
    }
    const out = createWriteStream(file, { flags: "a" });
    try {
      for await (const chunk of Readable.fromWeb(res.body as never) as AsyncIterable<Buffer>) {
        clearTimeout(timer);
        timer = setTimeout(stop, o.stallMs);
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        onBytes(chunk.length);
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", stop);
  }
}

/**
 * Downloads the file in pieces at once and joins them into `part`. Resolves true when the file is whole, false when the
 * server does not send ranges (the caller downloads it in one go), null when stopped.
 */
export async function downloadInPieces(o: SegmentOptions): Promise<boolean | null> {
  const files = Array.from({ length: o.pieces }, (_, i) => pieceFile(o.part, i));
  const sizes = files.map(sizeOf);
  const report = () => o.progress(sizes.reduce((a, b) => a + b, 0));
  let failures: string[] = [];

  const piece = async (i: number) => {
    const [start, end] = rangeOf(i, o.pieces, o.size);
    const length = end - start + 1;
    let idle = 0;
    while (sizes[i]! < length && idle < o.stalledRounds) {
      const before = sizes[i]!;
      for (const way of o.ways) {
        if (o.signal.aborted) return;
        try {
          await fetchRange(way, files[i]!, start + sizes[i]!, end, o, (n) => {
            sizes[i]! += n;
            report();
          });
          o.worked(way.key);
          break;
        } catch (err) {
          if (err instanceof NoRanges) throw err;
          if (o.signal.aborted) return;
          failures.push(`${way.key}: ${err instanceof Error ? err.message : String(err)}`);
          if (sizes[i]! > before) break;
        }
      }
      // A piece that got more than its range is broken: it starts over.
      if (sizes[i]! > length) {
        rmSync(files[i]!, { force: true });
        sizes[i] = 0;
      }
      idle = sizes[i]! > before ? 0 : idle + 1;
      if (sizes[i]! < length && idle > 0) await new Promise((r) => setTimeout(r, o.retryMs));
    }
    if (sizes[i]! < length && !o.signal.aborted) throw new Error(`a piece did not come (${failures.slice(-3).join("; ")})`);
  };

  try {
    await Promise.all(files.map((_, i) => piece(i)));
  } catch (err) {
    if (err instanceof NoRanges) {
      for (const f of files) rmSync(f, { force: true });
      return false;
    }
    throw err;
  }
  if (o.signal.aborted) return null;
  // Joined in order into the partial file; the pieces go.
  rmSync(o.part, { force: true });
  for (const f of files) await pipeline(createReadStream(f), createWriteStream(o.part, { flags: "a" }));
  for (const f of files) rmSync(f, { force: true });
  return true;
}
