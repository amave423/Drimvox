import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OllamaInstaller } from "../src/local/install";

const SETUP = Buffer.alloc(300_000, 7);
let server: Server;
let url: string;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "artel-install-"));
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(SETUP.length) });
    if (req.method === "HEAD") return res.end();
    // In pieces, so that progress shows.
    res.write(SETUP.subarray(0, 100_000));
    setTimeout(() => res.end(SETUP.subarray(100_000)), 50);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/OllamaSetup.exe`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe("installing Ollama from Artel", () => {
  it("says the download's size before anything starts", async () => {
    const installer = new OllamaInstaller({ url, dir, run: async () => {}, found: () => false });
    expect(await installer.size()).toBe(SETUP.length);
    expect(installer.state()).toMatchObject({ state: "idle" });
  });

  it("downloads the official setup, runs it and tells when Ollama is there", async () => {
    let ran: string | null = null;
    let installed = false;
    const installer = new OllamaInstaller({
      url,
      dir,
      run: async (file) => {
        ran = file;
        installed = true;
      },
      found: () => installed,
    });
    installer.start();
    await until(() => installer.state().state === "done" || installer.state().state === "failed");
    expect(installer.state()).toMatchObject({ state: "done", received: SETUP.length, total: SETUP.length });
    expect(readFileSync(ran!).equals(SETUP)).toBe(true);
  });

  it("fails honestly when the setup ran but Ollama is still not found", async () => {
    const installer = new OllamaInstaller({ url, dir, run: async () => {}, found: () => false });
    installer.start();
    await until(() => installer.state().state === "failed");
    expect(installer.state()).toMatchObject({ state: "failed", error: "not_found" });
  });
});

describe("installing Ollama through the API", () => {
  it("installs and then reports Ollama as there, without hanging on a program that will not start", async () => {
    const { createTestEnv } = await import("./env");
    const env = createTestEnv();
    try {
      env.setLocal({
        command: null,
        hardware: { ramBytes: 16 * 2 ** 30, gpu: null, unified: false },
        registryUrl: "http://127.0.0.1:9",
        hfUrl: "http://127.0.0.1:9",
        install: { url, skipRun: true, command: ["artel-no-such-ollama"], can: true },
      });
      expect((await env.call("POST", "/api/local/install")).status).toBe(202);
      const started = Date.now();
      let status: any;
      for (let i = 0; i < 100; i++) {
        status = await (await env.call("GET", "/api/local")).json();
        if (status.installed) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(status).toMatchObject({ installed: true, install: { state: "done", total: SETUP.length } });
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      await env.closeAsync();
    }
  });
});
