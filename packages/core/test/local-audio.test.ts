// docs/specs/local-audio.md: speech on this computer through whisper.cpp, which Drimvox downloads itself.
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeHub } from "./fake-hub";

const FAKE_WHISPER = fileURLToPath(new URL("./fake-whisper.mjs", import.meta.url));
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

const status = async () => (await env.call("GET", "/api/local/audio")).json();
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 400)}`);
    await sleep(50);
  }
}

// Asked for: a search of speech models on Hugging Face, like the other tabs have.
describe("speech models from Hugging Face", () => {
  it("finds the ones whisper.cpp runs, downloads a file, lists it and deletes it", async () => {
    const { url } = await startFakeHub(servers);
    env.setLocal({ command: null, registryUrl: "http://127.0.0.1:9", hfUrl: url, hfFiles: [url], audio: { engineUrl: `${url}/whisper.zip`, cliCommand: [process.execPath, FAKE_WHISPER] } });
    const found = await (await env.call("GET", "/api/local/audio/search?q=whisper")).json();
    expect(found).toEqual([
      { repo: "someone/whisper-ru-ggml", downloads: 800, runnable: true },
      { repo: "openai/whisper-large-v3", downloads: 90000, runnable: false },
    ]);
    const files = await (await env.call("GET", "/api/local/audio/hf?repo=someone/whisper-ru-ggml")).json();
    expect(files).toEqual([expect.objectContaining({ model: "hf:someone/whisper-ru-ggml:ggml-ru-q5_0.bin", installed: false })]);

    const id = files[0].model;
    expect((await env.call("POST", "/api/local/audio/pulls", { model: id })).status).toBe(202);
    const after = await until(status, (s) => s.models.find((m: { id: string }) => m.id === id)?.installed);
    expect(after.models.find((m: { id: string }) => m.id === id)).toMatchObject({ source: "hf", name: "ru-q5_0 · someone", note: null });
    const models = await (await env.call("GET", `/api/providers/${after.providerId}/models`)).json();
    expect(models.map((m: { id: string }) => m.id)).toEqual([id]);

    expect((await env.call("DELETE", `/api/local/audio/models?model=${encodeURIComponent(id)}`)).status).toBe(204);
    expect((await status()).models.some((m: { id: string }) => m.id === id)).toBe(false);
  });
});

// Asked for: an engine for local audio models and an Audio tab.
describe("speech on this computer", () => {
  it("downloads the engine with a model, and writes dictation down with it", async () => {
    const { url } = await startFakeHub(servers);
    env.setLocal({
      command: null,
      registryUrl: "http://127.0.0.1:9",
      hfUrl: url,
      hfFiles: [url],
      audio: { engineUrl: `${url}/whisper.zip`, cliCommand: [process.execPath, FAKE_WHISPER] },
    });
    const before = await status();
    expect(before).toMatchObject({ supported: true, engine: false, providerId: null });
    expect(before.models.map((m: { id: string }) => m.id)).toEqual(["whisper-base", "whisper-small", "whisper-turbo"]);

    expect((await env.call("POST", "/api/local/audio/pulls", { model: "whisper-small" })).status).toBe(202);
    const after = await until(status, (s) => s.models.find((m: { id: string }) => m.id === "whisper-small").installed);
    expect(after).toMatchObject({ engine: true });
    expect(after.providerId).toBeTruthy();

    // The engine's provider lists the downloaded model as one that hears.
    const models = await (await env.call("GET", `/api/providers/${after.providerId}/models`)).json();
    expect(models).toEqual([expect.objectContaining({ id: "whisper-small", audio: true, priceIn: 0, priceOut: 0 })]);

    await env.call("PATCH", "/api/settings", { voiceModel: { providerId: after.providerId, model: "whisper-small" } });
    const res = await env.call("POST", "/api/voice/transcribe", { audio: Buffer.from("RIFF....WAVE").toString("base64"), mimeType: "audio/wav" });
    expect(await res.json()).toEqual({ text: "Привет из whisper." });

    // Asked for: a way to delete the engines. The models stay; asking for one again brings the engine back.
    expect((await env.call("DELETE", "/api/local/audio/engine")).status).toBe(204);
    expect(await status()).toMatchObject({ engine: false });
    expect((await env.call("POST", "/api/local/audio/pulls", { model: "whisper-small" })).status).toBe(202);
    await until(status, (s) => s.engine === true);
  });
});
