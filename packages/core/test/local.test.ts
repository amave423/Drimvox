import type { LocalHardware } from "@artel/shared";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GB } from "../src/local/fit";
import { createTestEnv, readEvents, type TestEnv } from "./env";

const FAKE = fileURLToPath(new URL("./fake-ollama.mjs", import.meta.url));
const desktop: LocalHardware = { ramBytes: 32 * GB, gpu: { name: "RTX 3080", vramBytes: 10 * GB }, unified: false };
const laptop: LocalHardware = { ramBytes: 8 * GB, gpu: null, unified: false };

let env: TestEnv;
let port: number;
let servers: Server[] = [];
let userOllama: ChildProcess | undefined;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
const base = () => `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const answers = async () => {
  try {
    return (await fetch(`${base()}/api/version`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
};
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 300)}`);
    await sleep(50);
  }
}

/** A Hugging Face and an Ollama registry on this computer. */
async function serve(handler: (path: string, url: URL) => unknown): Promise<string> {
  const s = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const body = handler(url.pathname, url);
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { errors: [{ code: "MANIFEST_UNKNOWN" }] }));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

function setup(o: { installed?: boolean; idleMs?: number; hardware?: LocalHardware; models?: string[]; pullMs?: number; keepMs?: number; registry?: string; hf?: string } = {}) {
  env.setPresetUrl("ollama", `${base()}/v1`);
  env.setLocal({
    command: o.installed === false ? null : [process.execPath, FAKE],
    commandEnv: {
      FAKE_OLLAMA_MODELS: JSON.stringify(o.models ?? []),
      FAKE_OLLAMA_PULL_MS: String(o.pullMs ?? 10),
      FAKE_OLLAMA_KEEP_MS: String(o.keepMs ?? 50),
    },
    idleMs: o.idleMs ?? 60_000,
    hardware: o.hardware ?? desktop,
    ...(o.registry ? { registryUrl: o.registry } : {}),
    ...(o.hf ? { hfUrl: o.hf } : {}),
  });
}
const status = async () => (await env.call("GET", "/api/local")).json();

beforeEach(async () => {
  env = createTestEnv();
  port = await freePort();
});

afterEach(async () => {
  await env.closeAsync();
  userOllama?.kill();
  userOllama = undefined;
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

describe("Ollama on this computer", () => {
  it("says it is not installed when there is no program and nothing answers", async () => {
    setup({ installed: false });
    expect(await status()).toMatchObject({ installed: false, running: false, managed: false, models: [], hardware: desktop });
  });

  it("starts Ollama when needed, with a context window sized for the computer, and stops it once idle", async () => {
    setup({ idleMs: 400, models: ["gemma4:e2b"] });
    const s = await status();
    expect(s).toMatchObject({ installed: true, running: true, managed: true, version: "0.31.1-fake" });
    expect(s.models).toEqual([{ name: "gemma4:e2b", sizeBytes: 1000, modifiedAt: "2026-10-13T10:00:00Z" }]);
    expect(await (await fetch(`${base()}/fake/env`)).json()).toMatchObject({ contextLength: "16384" });
    await until(answers, (up) => !up, 5_000);
  });

  it("gives a bigger context window to a computer with a lot of video memory", async () => {
    setup({ hardware: { ramBytes: 64 * GB, gpu: { name: "RTX 4090", vramBytes: 24 * GB }, unified: false } });
    await status();
    expect(await (await fetch(`${base()}/fake/env`)).json()).toMatchObject({ contextLength: "32768" });
  });

  it("keeps it while a model is downloading", async () => {
    setup({ idleMs: 200, pullMs: 120 });
    await status();
    expect((await env.call("POST", "/api/local/pulls", { model: "gemma4:e2b" })).status).toBe(202);
    await sleep(700);
    expect(await answers()).toBe(true);
    await until(status, (s) => s.pulls.every((p: any) => p.done));
    await until(answers, (up) => !up, 5_000);
  });

  it("keeps it while a model is still loaded after a chat", async () => {
    setup({ idleMs: 200, keepMs: 1_500, models: ["gemma4:e2b"] });
    await env.call("POST", "/api/local/connect");
    const provider = (await (await env.call("GET", "/api/providers")).json()).find((p: any) => p.preset === "ollama");
    const chat = await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "gemma4:e2b" })).json();
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Привет" }));
    await sleep(700);
    expect(await answers()).toBe(true);
    await until(answers, (up) => !up, 6_000);
  });

  it("leaves alone an Ollama the user started", async () => {
    userOllama = spawn(process.execPath, [FAKE], { env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}` }, stdio: "ignore" });
    await until(answers, (up) => up);
    setup({ idleMs: 150 });
    expect(await status()).toMatchObject({ running: true, managed: false });
    await sleep(600);
    expect(await answers()).toBe(true);
  });
});

describe("downloads", () => {
  it("pulls with progress, then adds the Ollama provider so chat can use it", async () => {
    setup({ pullMs: 30 });
    expect((await status()).providerId).toBeNull();
    const res = await env.call("POST", "/api/local/pulls", { model: "gemma4:e2b" });
    expect(res.status).toBe(202);
    const mid = await until(status, (s) => s.pulls[0]?.completed > 0 && !s.pulls[0]?.done);
    expect(mid.pulls[0]).toMatchObject({ model: "gemma4:e2b", total: 1000, done: false, error: null });
    const after = await until(status, (s) => s.pulls[0]?.done);
    expect(after.pulls[0]).toMatchObject({ done: true, error: null, status: "success" });
    expect(after.models.map((m: any) => m.name)).toEqual(["gemma4:e2b"]);

    const providers = await (await env.call("GET", "/api/providers")).json();
    const ollama = providers.find((p: any) => p.preset === "ollama");
    expect(ollama).toBeTruthy();
    expect(after.providerId ?? (await status()).providerId).toBe(ollama.id);
    const models = await (await env.call("GET", `/api/providers/${ollama.id}/models`)).json();
    expect(models.map((m: any) => m.id)).toContain("gemma4:e2b");
  });

  it("can be cancelled", async () => {
    setup({ pullMs: 200 });
    await env.call("POST", "/api/local/pulls", { model: "qwen3:8b" });
    await until(status, (s) => s.pulls[0]?.completed > 0);
    expect((await env.call("DELETE", "/api/local/pulls?model=qwen3:8b")).status).toBe(200);
    const s = await status();
    expect(s.pulls).toEqual([]);
    expect(s.models).toEqual([]);
  });

  it("reports a model that does not exist", async () => {
    setup();
    await env.call("POST", "/api/local/pulls", { model: "missing:1b" });
    const s = await until(status, (v) => v.pulls[0]?.done);
    expect(s.pulls[0].error).toMatch(/does not exist/);
  });

  it("refuses names Ollama would not take", async () => {
    setup();
    expect((await env.call("POST", "/api/local/pulls", { model: "rm -rf /" })).status).toBe(400);
  });

  it("removes a downloaded model", async () => {
    setup({ models: ["gemma4:e2b", "qwen3:8b"] });
    expect((await env.call("DELETE", "/api/local/models?name=gemma4:e2b")).status).toBe(200);
    expect((await status()).models.map((m: any) => m.name)).toEqual(["qwen3:8b"]);
  });
});

describe("catalog", () => {
  const sizes: Record<string, number> = { "qwen3/1.7b": 1.3, "qwen3/4b": 2.3, "gemma4/e2b": 4.3, "qwen3/8b": 4.9, "gpt-oss/20b": 12.9, "qwen3.6/35b": 21 };
  const registry = () =>
    serve((path) => {
      const m = path.match(/^\/v2\/library\/([^/]+)\/manifests\/(.+)$/);
      const gb = m ? sizes[`${m[1]}/${m[2]}`] : undefined;
      return gb === undefined ? undefined : { layers: [{ size: Math.round(gb * GB) - 2000 }, { size: 1000 }, { size: 1000 }] };
    });

  it("offers picks sized from the registry and hides what this computer cannot run", async () => {
    setup({ registry: await registry(), hardware: laptop, models: ["qwen3:1.7b"] });
    const picks = await (await env.call("GET", "/api/local/picks")).json();
    // On 8 GB without a video card only the small ones run; tags the registry does not know are left out.
    expect(picks.map((p: any) => [p.model, p.fit, p.installed])).toEqual([
      ["qwen3:1.7b", "slow", true],
      ["qwen3:4b", "slow", false],
      ["gemma4:e2b", "slow", false],
    ]);
  });

  it("marks fast and slow picks on a computer with a video card", async () => {
    setup({ registry: await registry() });
    const picks = await (await env.call("GET", "/api/local/picks")).json();
    expect(picks.map((p: any) => [p.model, p.fit])).toEqual([
      ["qwen3:1.7b", "fast"],
      ["qwen3:4b", "fast"],
      ["gemma4:e2b", "fast"],
      ["qwen3:8b", "fast"],
      ["gpt-oss:20b", "slow"],
      ["qwen3.6:35b", "slow"],
    ]);
    expect(picks[0]).toMatchObject({ family: "qwen3-1.7b", uses: ["chat"] });
  });

  const hf = () =>
    serve((path, url) => {
      if (path === "/api/models") {
        expect(url.searchParams.get("search")).toBe("gemma");
        expect(url.searchParams.get("filter")).toBe("gguf");
        return [
          { id: "unsloth/gemma-4-12b-it-GGUF", downloads: 1654466, likes: 903, lastModified: "2026-07-17T12:52:56.000Z", gguf: { total: 11_907_350_576 } },
          { id: "someone/gemma-4-120b-GGUF", downloads: 10, likes: 1, gguf: { total: 120_000_000_000 } },
          { id: "someone/gemma-tiny-GGUF", downloads: 5, likes: 0 },
          { id: "mlabonne/gemma-4-12b-abliterated-GGUF", downloads: 900, likes: 40, gguf: { total: 11_907_350_576 } },
          { id: "someone/gemma-chat-GGUF", downloads: 30, likes: 2, tags: ["gguf", "uncensored"] },
        ];
      }
      if (path === "/api/models/unsloth/gemma-4-12b-it-GGUF/tree/main") {
        return [
          { type: "file", path: "gemma-4-12b-it-Q4_K_M.gguf", size: 7 * GB },
          { type: "file", path: "gemma-4-12b-it-Q8_0.gguf", size: 12.5 * GB },
          { type: "file", path: "mmproj-F16.gguf", size: 0.8 * GB },
        ];
      }
      return undefined;
    });

  it("searches GGUF models on Hugging Face and hides repositories too big for this computer", async () => {
    setup({ hf: await hf() });
    const found = await (await env.call("GET", "/api/local/search?q=gemma")).json();
    expect(found).toEqual([
      { repo: "unsloth/gemma-4-12b-it-GGUF", downloads: 1654466, likes: 903, params: 11_907_350_576, updatedAt: "2026-07-17T12:52:56.000Z", unfiltered: false },
      { repo: "someone/gemma-tiny-GGUF", downloads: 5, likes: 0, params: null, updatedAt: null, unfiltered: false },
      // What the author says, by the name or the tags: Artel cannot check it.
      { repo: "mlabonne/gemma-4-12b-abliterated-GGUF", downloads: 900, likes: 40, params: 11_907_350_576, updatedAt: null, unfiltered: true },
      { repo: "someone/gemma-chat-GGUF", downloads: 30, likes: 2, params: null, updatedAt: null, unfiltered: true },
    ]);
  });

  it("lists a repository's variants with the advice", async () => {
    setup({ hf: await hf() });
    const variants = await (await env.call("GET", "/api/local/hf?repo=unsloth/gemma-4-12b-it-GGUF")).json();
    expect(variants.map((v: any) => [v.quant, v.fit, v.recommended, v.model])).toEqual([
      ["Q4_K_M", "fast", true, "hf.co/unsloth/gemma-4-12b-it-GGUF:Q4_K_M"],
      ["Q8_0", "slow", false, "hf.co/unsloth/gemma-4-12b-it-GGUF:Q8_0"],
    ]);
  });

  it("says so when Hugging Face does not answer", async () => {
    setup({ hf: "http://127.0.0.1:9" });
    const res = await env.call("GET", "/api/local/search?q=gemma");
    expect(res.status).toBe(502);
  });
});

describe("what a local model can do", () => {
  it("reads tools, pictures and the context window from Ollama, and keeps tools from models too small for them", async () => {
    setup({ models: ["llama3.2:3b", "qwen3:8b", "gemma4:e4b"] });
    const { providerId } = await (await env.call("POST", "/api/local/connect")).json();
    const models = await (await env.call("GET", `/api/providers/${providerId}/models`)).json();
    const of = (id: string) => models.find((m: any) => m.id === id);
    expect(of("llama3.2:3b")).toMatchObject({ tools: false, vision: false, contextLength: 131072 });
    expect(of("qwen3:8b")).toMatchObject({ tools: true, vision: false });
    expect(of("gemma4:e4b")).toMatchObject({ tools: true, vision: true });
  });

  // Seen live: llama3.2:3b with search on answered "привет" by writing a search call as text.
  it("chats with a model too small for tools without giving it the internet", async () => {
    setup({ models: ["llama3.2:3b"] });
    const { providerId } = await (await env.call("POST", "/api/local/connect")).json();
    const chat = await (await env.call("POST", "/api/chats", { providerId, model: "llama3.2:3b" })).json();
    await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "привет, как дела?", web: "free" }));
    const sent = (await (await fetch(`${base()}/fake/requests`)).json()) as any[];
    expect(sent).toHaveLength(1);
    expect(sent[0].tools).toBeUndefined();
  });
});

describe("chat", () => {
  it("wakes Ollama for a chat on a local model", async () => {
    setup({ models: ["gemma4:e2b"] });
    await env.call("POST", "/api/local/connect");
    const provider = (await (await env.call("GET", "/api/providers")).json()).find((p: any) => p.preset === "ollama");
    // Ollama went away between messages; the next message brings it back.
    env.setLocal({ command: [process.execPath, FAKE], commandEnv: { FAKE_OLLAMA_MODELS: '["gemma4:e2b"]' }, idleMs: 60_000, hardware: desktop });
    expect(await answers()).toBe(false);
    const chat = await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "gemma4:e2b" })).json();
    const done = (await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Привет" }))).at(-1);
    expect(done.message.content).toBe("Привет из Ollama");
  });
});
