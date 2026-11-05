import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ollamaArchive, OllamaInstaller, ownOllama, unpackWithTar } from "../src/local/install";

const ARCHIVE = Buffer.alloc(300_000, 7);
let server: Server;
let url: string;
let dir: string;
/** What sha256sum.txt lists for the archive; null: no list at all. */
let listed: string | null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "drimvox-install-"));
  listed = createHash("sha256").update(ARCHIVE).digest("hex");
  server = createServer((req, res) => {
    if (req.url?.endsWith("/sha256sum.txt")) {
      if (!listed) return res.writeHead(404).end();
      return res.end(`${"0".repeat(64)}  ./ollama-darwin.tgz\n${listed}  ./ollama-windows-amd64.zip\n`);
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(ARCHIVE.length) });
    if (req.method === "HEAD") return res.end();
    // In pieces, so that progress shows.
    res.write(ARCHIVE.subarray(0, 100_000));
    setTimeout(() => res.end(ARCHIVE.subarray(100_000)), 50);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/download/ollama-windows-amd64.zip`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

// Asked for: the official setup installed a whole app with a tray icon and a sign-in; the plain build has neither.
describe("installing Ollama from Drimvox", () => {
  it("takes Ollama's plain build for this computer, not its setup", () => {
    expect(ollamaArchive("win32", "x64")).toBe("ollama-windows-amd64.zip");
    expect(ollamaArchive("win32", "arm64")).toBe("ollama-windows-arm64.zip");
    expect(ollamaArchive("darwin", "arm64")).toBe("ollama-darwin.tgz");
    expect(ollamaArchive("linux", "x64")).toBeNull();
  });

  it("says the download's size before anything starts", async () => {
    const installer = new OllamaInstaller({ url, dir: join(dir, "ollama"), unpack: async () => {}, found: () => false });
    expect(await installer.size()).toBe(ARCHIVE.length);
    expect(installer.state()).toMatchObject({ state: "idle" });
  });

  it("downloads the archive, checks it against Ollama's checksums, unpacks it into its folder and tells when Ollama is there", async () => {
    let unpacked: Buffer | null = null;
    const target = join(dir, "engines", "ollama");
    const installer = new OllamaInstaller({
      url,
      dir: target,
      unpack: async (archive, into) => {
        unpacked = readFileSync(archive);
        mkdirSync(into, { recursive: true });
        writeFileSync(join(into, "ollama.exe"), "");
      },
      found: () => existsSync(join(target, "ollama.exe")),
    });
    installer.start();
    await until(() => installer.state().state === "done" || installer.state().state === "failed");
    expect(installer.state()).toMatchObject({ state: "done", received: ARCHIVE.length, total: ARCHIVE.length });
    expect(unpacked!.equals(ARCHIVE)).toBe(true);
    // The archive itself does not stay behind.
    expect(existsSync(join(dir, "engines")) && !existsSync(join(dir, "engines", "ollama.windows-amd64.zip"))).toBe(true);
  });

  it("refuses an archive that is not what Ollama's checksums say", async () => {
    listed = "f".repeat(64);
    let unpacked = false;
    const installer = new OllamaInstaller({ url, dir: join(dir, "ollama"), unpack: async () => void (unpacked = true), found: () => true });
    installer.start();
    await until(() => installer.state().state === "failed" || installer.state().state === "done");
    expect(installer.state()).toMatchObject({ state: "failed", error: "download" });
    expect(unpacked).toBe(false);
  });

  it("fails honestly when the archive was unpacked but Ollama is still not found", async () => {
    const installer = new OllamaInstaller({
      url,
      dir: join(dir, "ollama"),
      unpack: async (_, into) => void mkdirSync(into, { recursive: true }),
      found: () => false,
    });
    installer.start();
    await until(() => installer.state().state === "failed");
    expect(installer.state()).toMatchObject({ state: "failed", error: "not_found" });
  });

  // Windows and macOS have a tar that opens zip archives; it unpacks from disk, never the whole archive in memory.
  it.skipIf(process.platform === "linux")("unpacks a real zip with the system's tar and finds the program in it", async () => {
    const archive = join(dir, "ollama.zip");
    const name = process.platform === "win32" ? "ollama.exe" : "ollama";
    writeFileSync(archive, zipSync({ [name]: new Uint8Array([1, 2, 3]), "lib/ollama/libggml.dll": new Uint8Array([4]) }));
    await unpackWithTar(archive, join(dir, "out"));
    expect(ownOllama(join(dir, "out"))).toEqual([join(dir, "out", name)]);
    expect(readFileSync(join(dir, "out", "lib", "ollama", "libggml.dll"))).toEqual(Buffer.from([4]));
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
        install: { url, skipRun: true, command: ["drimvox-no-such-ollama"], can: true },
      });
      expect((await env.call("POST", "/api/local/install")).status).toBe(202);
      const started = Date.now();
      let status: any;
      for (let i = 0; i < 100; i++) {
        status = await (await env.call("GET", "/api/local")).json();
        if (status.installed) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(status).toMatchObject({ installed: true, install: { state: "done", total: ARCHIVE.length } });
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      await env.closeAsync();
    }
  });
});
