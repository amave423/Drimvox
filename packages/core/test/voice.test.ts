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
    const asked = fake.requests.find((r) => r.path === "/v1/chat/completions")!.body;
    expect(JSON.stringify(asked.messages)).toMatch(/input_audio/);
    // No thinking for writing down (seen: a free reasoning model answered with nothing every time).
    expect(asked.reasoning).toEqual({ enabled: false });
  });

  it("says when the model heard nothing, and passes on the provider's own words when it fails", async () => {
    fake = await startFakeProvider({ key: KEY, models: [{ id: "ears" }], script: [{ text: "" }, { fail: { status: 400, message: "Audio input is not supported for this model" } }] });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    await env.call("PATCH", "/api/settings", { voiceModel: { providerId: provider.id, model: "ears" } });
    const empty = await env.call("POST", "/api/voice/transcribe", { audio: wav(), mimeType: "audio/wav" });
    expect(empty.status).toBe(422);
    expect(await empty.json()).toEqual({ error: { code: "nothing_heard" } });
    const failed = await env.call("POST", "/api/voice/transcribe", { audio: wav(), mimeType: "audio/wav" });
    expect(failed.status).toBe(502);
    expect((await failed.json()).error.detail).toContain("Audio input is not supported");
  });
});

// Asked for: voices from the cloud for reading answers.
describe("a provider's voice reads answers", () => {
  it("asks Gemini's newest Flash speech model with the chosen voice and gives a WAV", async () => {
    const pcm = Buffer.alloc(4800, 1);
    // Google's content credentials after the sound (seen live: played, they were a blast of noise).
    const credentials = Buffer.concat([Buffer.from("C2PA"), Buffer.from([0xb0, 0x17, 0, 0, 0, 0, 0x17, 0xb0]), Buffer.from("jumb"), Buffer.alloc(3000, 0x7f)]);
    fake = await startFakeProvider({
      authorized: (h) => h["x-goog-api-key"] === KEY,
      handle: (method, path) => {
        if (method === "GET" && path === "/v1beta/models") return { json: { models: ["gemini-2.5-flash-preview-tts", "gemini-3.5-flash-tts", "gemini-3.5-pro-tts", "gemini-3.5-flash"].map((m) => ({ name: `models/${m}` })) } };
        if (method === "POST" && path === "/v1beta/models/gemini-3.5-flash-tts:generateContent")
          return { json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.concat([pcm, credentials]).toString("base64") } }] } }] } };
        return undefined;
      },
    });
    env.setPresetUrl("google", `${fake.origin}/v1beta`);
    const google = await (await env.call("POST", "/api/providers", { preset: "google", apiKey: KEY })).json();
    // Nothing chosen: said so.
    expect((await env.call("POST", "/api/voice/speak", { text: "Привет" })).status).toBe(409);

    await env.call("PATCH", "/api/settings", { cloudVoice: { providerId: google.id, voice: "Kore" } });
    const res = await env.call("POST", "/api/voice/speak", { text: "Привет из облака." });
    expect(res.status).toBe(200);
    const wav = Buffer.from(await res.arrayBuffer());
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(24000);
    // The sound alone, without the credentials; it fades out instead of ending on a click.
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.indexOf("C2PA")).toBe(-1);
    expect(wav.readInt16LE(wav.length - 2)).toBe(0);
    const asked = fake.requests.find((r) => r.path.endsWith(":generateContent"))!.body;
    expect(asked.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
    expect(JSON.stringify(asked.contents)).toContain("Привет из облака.");
  });

  it("asks OpenAI's speech model, and passes on the provider's words when it refuses", async () => {
    let refuse = false;
    fake = await startFakeProvider({
      authorized: (h) => h.authorization === `Bearer ${KEY}`,
      handle: (method, path) => {
        if (method === "POST" && path === "/v1/audio/speech") return refuse ? { status: 429, json: { error: { message: "You exceeded your current quota" } } } : { bytes: Buffer.from("RIFF0000WAVE"), contentType: "audio/wav" };
        return undefined;
      },
    });
    env.setPresetUrl("openai", `${fake.origin}/v1`);
    const openai = await (await env.call("POST", "/api/providers", { preset: "openai", apiKey: KEY })).json();
    await env.call("PATCH", "/api/settings", { cloudVoice: { providerId: openai.id, voice: "nova" } });
    const res = await env.call("POST", "/api/voice/speak", { text: "Привет" });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("RIFF0000WAVE");
    expect(fake.requests.find((r) => r.path === "/v1/audio/speech")!.body).toMatchObject({ model: "gpt-4o-mini-tts", voice: "nova", input: "Привет", response_format: "wav" });
    refuse = true;
    const refused = await env.call("POST", "/api/voice/speak", { text: "Привет" });
    expect(refused.status).toBe(502);
    expect((await refused.json()).error.detail).toContain("exceeded your current quota");
  });
});
