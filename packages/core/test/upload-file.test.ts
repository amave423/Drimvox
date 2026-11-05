import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { uploadFile } from "../src/local/hf-download";

// Seen live: a 29 GB model sent to Ollama through fetch was read whole into the core's memory and brought it down.
describe("uploadFile", () => {
  it("sends the file whole as the body and says the answer's status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drimvox-upload-"));
    const file = join(dir, "model.gguf");
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    writeFileSync(file, bytes);
    let got: { length: string | undefined; sha: string } | null = null;
    const server = createServer((req, res) => {
      const hash = createHash("sha256");
      req.on("data", (c: Buffer) => hash.update(c));
      req.on("end", () => {
        got = { length: req.headers["content-length"], sha: hash.digest("hex") };
        res.writeHead(201).end();
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const status = await uploadFile(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/blobs/x`, file, new AbortController().signal);
      expect(status).toBe(201);
      expect(got).toEqual({ length: String(bytes.length), sha: createHash("sha256").update(bytes).digest("hex") });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
