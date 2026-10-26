import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadFile, fileByPath } from "../src/local/hf-download";
import { startFakeHub } from "./fake-hub";

let servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Asked for: downloads felt capped. One connection (through a proxy, too) was the limit; a big file now comes in pieces.
describe("downloading a big file in pieces", () => {
  it("fetches its parts at once over several connections and joins them into the right file", async () => {
    const hub = await startFakeHub(servers);
    const dir = mkdtempSync(join(tmpdir(), "drimvox-pieces-"));
    dirs.push(dir);
    const repo = "ggerganov/whisper.cpp";
    const info = await fileByPath(hub.url, repo, "ggml-base.bin", AbortSignal.timeout(10_000));
    const seen: number[] = [];
    const part = await downloadFile(
      {
        apiUrl: hub.url,
        bases: [hub.url],
        routes: [{ label: "direct", fetch }],
        dir,
        signal: new AbortController().signal,
        partial: () => {},
        progress: (s) => s.status === "downloading" && seen.push(s.completed),
        pieces: 4,
        piecesFrom: 1024,
      },
      repo,
      info,
    );
    expect(part).toBeTruthy();
    // Four requests for one file, each a part of it; the result passes the checksum and nothing is left over.
    expect(hub.files.get("ggml-base.bin")).toBe(4);
    expect(readFileSync(part!).toString()).toBe("ggml-base.bin ".repeat(2000));
    expect(readdirSync(dir)).toEqual([info.sha256 + ".part"]);
    expect(Math.max(...seen)).toBe(info.size);
  });
});
