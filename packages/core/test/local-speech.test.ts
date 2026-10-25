// docs/specs/local-speech.md: answers read aloud on this computer by Piper, which Drimvox downloads itself.
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeHub } from "./fake-hub";

const FAKE_PIPER = fileURLToPath(new URL("./fake-piper.mjs", import.meta.url));
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

const status = async () => (await env.call("GET", "/api/local/speech")).json();
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 400)}`);
    await sleep(50);
  }
}

// Asked for: reading answers aloud with Piper, since the system's voice sounded like a robot.
describe("reading aloud on this computer", () => {
  it("downloads the engine with a voice, reads a text with it, and deletes both", async () => {
    const { url } = await startFakeHub(servers);
    env.setLocal({ command: null, registryUrl: "http://127.0.0.1:9", hfUrl: url, hfFiles: [url], speech: { engineUrl: `${url}/piper.zip`, command: [process.execPath, FAKE_PIPER] } });
    const before = await status();
    expect(before).toMatchObject({ supported: true, engine: false });
    expect(before.voices.map((v: { id: string }) => v.id)).toEqual(["ru-irina", "ru-denis", "ru-dmitri", "ru-ruslan", "en-amy", "en-lessac"]);

    // Without a voice chosen, there is nothing to read with.
    expect((await env.call("POST", "/api/voice/speak", { text: "Привет" })).status).toBe(409);

    expect((await env.call("POST", "/api/local/speech/pulls", { voice: "ru-irina" })).status).toBe(202);
    const after = await until(status, (s) => s.voices.find((v: { id: string }) => v.id === "ru-irina").installed);
    expect(after).toMatchObject({ engine: true });

    await env.call("PATCH", "/api/settings", { speechVoice: "ru-irina" });
    const res = await env.call("POST", "/api/voice/speak", { text: "Привет из Piper." });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    const wav = Buffer.from(await res.arrayBuffer()).toString("utf8");
    expect(wav.startsWith("RIFF")).toBe(true);
    expect(wav).toContain("Привет из Piper.");

    expect((await env.call("DELETE", "/api/local/speech/engine")).status).toBe(204);
    expect((await env.call("DELETE", "/api/local/speech/voices?voice=ru-irina")).status).toBe(204);
    const gone = await status();
    expect(gone).toMatchObject({ engine: false });
    expect(gone.voices.find((v: { id: string }) => v.id === "ru-irina").installed).toBe(false);
  });
});
