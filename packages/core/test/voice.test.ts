import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider } from "./fake-provider";

const KEY = "good-key";
let env: TestEnv;
let fake: FakeProvider;

beforeEach(() => {
  env = createTestEnv();
});
afterEach(async () => {
  env.close();
  await fake?.close();
});

// A tiny WAV: the header and a few samples of silence.
function wav(): string {
  const samples = 160;
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  return b.toString("base64");
}

// Asked for: dictate a message.
describe("dictation", () => {
  it("turns a recording into text with the voice model from the settings", async () => {
    fake = await startFakeProvider({ key: KEY, models: [{ id: "ears" }], script: [{ text: "Привет, мир" }] });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    // No voice model yet: said so.
    const none = await env.call("POST", "/api/voice/transcribe", { audio: wav(), mimeType: "audio/wav" });
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ error: { code: "no_voice_model" } });

    await env.call("PATCH", "/api/settings", { voiceModel: { providerId: provider.id, model: "ears" } });
    const res = await env.call("POST", "/api/voice/transcribe", { audio: wav(), mimeType: "audio/wav" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Привет, мир" });
    const sent = JSON.stringify(fake.requests.find((r) => r.path === "/v1/chat/completions")!.body.messages);
    expect(sent).toMatch(/input_audio/);
  });
});
