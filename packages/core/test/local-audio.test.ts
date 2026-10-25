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
  });
});
