// docs/specs/local-images.md: pictures on this computer through stable-diffusion.cpp, which Artel downloads itself.
import type { LocalHardware } from "@artel/shared";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeHub } from "./fake-hub";

const GB = 2 ** 30;
const FAKE_SD = fileURLToPath(new URL("./fake-sd.mjs", import.meta.url));
const desktop: LocalHardware = { ramBytes: 32 * GB, gpu: { name: "RTX 3080", vramBytes: 10 * GB }, unified: false };

let env: TestEnv;
let servers: Server[] = [];

beforeEach(() => {
  env = createTestEnv();
});

afterEach(async () => {
  await env.closeAsync();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

function setup(url: string, o: { hardware?: LocalHardware; idleMs?: number; engineUrl?: string | null; sdEnv?: Record<string, string> } = {}) {
  env.setLocal({
    command: null,
    hardware: o.hardware ?? desktop,
    registryUrl: "http://127.0.0.1:9",
    hfUrl: url,
    hfFiles: [url],
    images: {
      engineUrl: o.engineUrl === undefined ? `${url}/engine.zip` : o.engineUrl,
      serverCommand: [process.execPath, FAKE_SD],
      serverEnv: { FAKE_SD_PORT_FILE: join(env.dir, "sd-port"), ...o.sdEnv },
      idleMs: o.idleMs ?? 60_000,
    },
  });
}

const status = async () => (await env.call("GET", "/api/local/images")).json();
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 400)}`);
    await sleep(50);
  }
}
const model = (s: any, id: string) => s.models.find((m: any) => m.id === id);
async function download(id: string) {
  expect((await env.call("POST", "/api/local/images/pulls", { model: id })).status).toBe(202);
  return until(status, (s) => model(s, id)?.installed === true);
}
async function draw(id: string, prompt: string, options: Record<string, unknown> = {}) {
  const { providerId } = await status();
  const chat = await (await env.call("POST", "/api/chats", { providerId, model: id, kind: "image" })).json();
  const events = await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: prompt, options }));
  return events.find((e) => e.type === "done").message;
}

describe("the short list", () => {
  it("shows only what runs here, with the variant sized for the computer", async () => {
    const { url } = await startFakeHub(servers);
    setup(url);
    const s = await status();
    expect(s).toMatchObject({ supported: true, engine: false, running: null, providerId: null });
    expect(s.models.map((m: any) => [m.id, m.fit, m.installed])).toEqual([
      ["z-image-turbo", "fast", false],
      ["qwen-image-2512", "slow", false],
    ]);
    // The four-bit Z-Image here; a card with 24 GB gets the eight-bit one.
    expect(model(s, "z-image-turbo").sizeBytes).toBeLessThan(7 * GB);
    setup(url, { hardware: { ramBytes: 64 * GB, gpu: { name: "RTX 4090", vramBytes: 24 * GB }, unified: false } });
    expect(model(await status(), "z-image-turbo").sizeBytes).toBeGreaterThan(10 * GB);
  });

  it("leaves out what does not fit, and says so where there is no engine for the system", async () => {
    const { url } = await startFakeHub(servers);
    setup(url, { hardware: { ramBytes: 8 * GB, gpu: null, unified: false } });
    expect((await status()).models).toEqual([]);
    setup(url, { engineUrl: null });
    expect(await status()).toMatchObject({ supported: false });
    expect((await env.call("POST", "/api/local/images/pulls", { model: "z-image-turbo" })).status).toBe(409);
  });
});

describe("downloading", () => {
  it("downloads the engine and the model's files once, then the picture chats have it", async () => {
    const hf = await startFakeHub(servers);
    setup(hf.url);
    const s = await download("z-image-turbo");
    expect(s.engine).toBe(true);
    expect(model(s, "z-image-turbo").pull).toMatchObject({ done: true, error: null });
    expect([...hf.files.keys()].sort()).toEqual(["Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "split_files/vae/ae.safetensors", "z_image_turbo-Q4_K.gguf"]);
    expect(s.providerId).toEqual(expect.any(String));

    const provider = (await (await env.call("GET", "/api/providers")).json()).find((p: any) => p.id === s.providerId);
    expect(provider).toMatchObject({ preset: "sdcpp", billing: "free" });
    const listed = await (await env.call("GET", `/api/providers/${s.providerId}/media-models?kind=image`)).json();
    expect(listed).toEqual([expect.objectContaining({ id: "z-image-turbo", name: "Z-Image Turbo", kind: "image", aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"] })]);
    expect(await (await env.call("GET", `/api/providers/${s.providerId}/media-models?kind=video`)).json()).toEqual([]);

    // Downloading it again takes nothing from the network.
    await env.call("POST", "/api/local/images/pulls", { model: "z-image-turbo" });
    await sleep(200);
    expect([...hf.files.values()]).toEqual([1, 1, 1]);
  });

  // The installer's box, or the sheet's button: the engine alone, before any model.
  it("downloads the engine alone, with its progress", async () => {
    const hf = await startFakeHub(servers);
    setup(hf.url);
    expect((await env.call("POST", "/api/local/images/engine")).status).toBe(202);
    const s = await until(status, (v) => v.engine === true);
    expect(s.enginePull).toMatchObject({ done: true, error: null });
    expect(hf.files.size).toBe(0);
    expect(model(s, "z-image-turbo").installed).toBe(false);
  });

  it("deletes a model's files, and the engine stays", async () => {
    const hf = await startFakeHub(servers);
    setup(hf.url);
    await download("z-image-turbo");
    expect((await env.call("DELETE", "/api/local/images/models/z-image-turbo")).status).toBe(200);
    const s = await status();
    expect(model(s, "z-image-turbo")).toMatchObject({ installed: false, pull: null });
    expect(s.engine).toBe(true);
    const left = readdirSync(join(env.dir, "images", "models"));
    expect(left).toEqual([]);
  });
});

describe("drawing", () => {
  it("starts the engine with the model's files, draws for free, and keeps it running for the next picture", async () => {
    const hf = await startFakeHub(servers);
    setup(hf.url);
    await download("z-image-turbo");
    const done = await draw("z-image-turbo", "Кот в очках", { aspectRatio: "16:9" });
    expect(done).toMatchObject({ status: "done", costUsd: 0, model: "z-image-turbo" });
    expect(done.media[0]).toMatchObject({ kind: "image", mime: "image/png", prompt: "Кот в очках" });

    const s = await status();
    expect(s.running).toBe("z-image-turbo");
    const port = await enginePort();
    const { args, pid } = await fake(port, "args");
    const arg = (name: string) => args[args.indexOf(name) + 1];
    expect(arg("--diffusion-model")).toMatch(/z_image_turbo-Q4_K\.gguf$/);
    expect(arg("--llm")).toMatch(/Qwen3-4B-Instruct-2507-Q4_K_M\.gguf$/);
    expect(arg("--vae")).toMatch(/ae\.safetensors$/);
    expect(arg("--listen-ip")).toBe("127.0.0.1");
    // Fits in video memory: nothing kept in main memory.
    expect(args).not.toContain("--offload-to-cpu");
    const [job] = await fake(port, "jobs");
    expect(job).toMatchObject({ prompt: "Кот в очках", width: 1344, height: 768, sample_params: { sample_steps: 8, guidance: { txt_cfg: 1 } } });

    await draw("z-image-turbo", "Пёс в шляпе");
    expect((await fake(port, "args")).pid).toBe(pid);
  });

  it("restarts the engine for another model, keeping a slow one partly in main memory", async () => {
    const hf = await startFakeHub(servers);
    setup(hf.url);
    await download("z-image-turbo");
    await download("qwen-image-2512");
    await draw("z-image-turbo", "Кот");
    await draw("qwen-image-2512", "Дом");
    expect((await status()).running).toBe("qwen-image-2512");
    const { args } = await fake(await enginePort(), "args");
    expect(args[args.indexOf("--diffusion-model") + 1]).toMatch(/qwen-image-2512-Q4_K_S\.gguf$/);
    expect(args).toContain("--offload-to-cpu");
  });

  it("puts the engine's error on the answer", async () => {
    const hf = await startFakeHub(servers);
    setup(hf.url, { sdEnv: { FAKE_SD_FAIL: "сломай" } });
    await download("z-image-turbo");
    const done = await draw("z-image-turbo", "сломай всё");
    expect(done).toMatchObject({ status: "error", error: { code: "provider_error", detail: "out of memory" } });
  });

  it("stops the engine when no pictures are drawn for a while", async () => {
    const hf = await startFakeHub(servers);
    setup(hf.url, { idleMs: 300 });
    await download("z-image-turbo");
    await draw("z-image-turbo", "Кот");
    const port = await enginePort();
    await until(
      async () => fetch(`http://127.0.0.1:${port}/fake/args`, { signal: AbortSignal.timeout(300) }).then(() => true, () => false),
      (up) => !up,
      5_000,
    );
    expect((await status()).running).toBeNull();
  });
});

/** What the fake engine was started with, or was asked to draw. */
const fake = async (port: number, what: "args" | "jobs"): Promise<any> => (await fetch(`http://127.0.0.1:${port}/fake/${what}`)).json();

/** The port the engine listens on: the fake writes it where FAKE_SD_PORT_FILE says. */
async function enginePort(): Promise<number> {
  const file = join(env.dir, "sd-port");
  await until(async () => existsSync(file), (ok) => ok);
  return Number(readFileSync(file, "utf8"));
}
