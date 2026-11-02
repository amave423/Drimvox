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

// Asked for: voices from every provider that has them, for reading answers.
describe("a provider's voice reads answers", () => {
  it("finds Gemini's speech models with their voices, reads with the chosen one and cuts Google's credentials off the sound", async () => {
    const pcm = Buffer.alloc(4800, 1);
    // Google's content credentials after the sound (seen live: played, they were a blast of noise).
    const credentials = Buffer.concat([Buffer.from("C2PA"), Buffer.from([0xb0, 0x17, 0, 0, 0, 0, 0x17, 0xb0]), Buffer.from("jumb"), Buffer.alloc(3000, 0x7f)]);
    fake = await startFakeProvider({
      authorized: (h) => h["x-goog-api-key"] === KEY,
      handle: (method, path) => {
        if (method === "GET" && path === "/v1beta/models") return { json: { models: [{ name: "models/gemini-3.5-flash-tts", displayName: "Gemini 3.5 Flash TTS" }, { name: "models/gemini-3.5-flash" }] } };
        if (method === "POST" && path === "/v1beta/models/gemini-3.5-flash-tts:generateContent")
          return { json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.concat([pcm, credentials]).toString("base64") } }] } }] } };
        return undefined;
      },
    });
    env.setPresetUrl("google", `${fake.origin}/v1beta`);
    const google = await (await env.call("POST", "/api/providers", { preset: "google", apiKey: KEY })).json();
    // Nothing chosen: said so.
    expect((await env.call("POST", "/api/voice/speak", { text: "Привет" })).status).toBe(409);

    const models = await (await env.call("GET", "/api/voice/cloud")).json();
    expect(models).toEqual([expect.objectContaining({ providerId: google.id, model: "gemini-3.5-flash-tts", name: "Gemini 3.5 Flash TTS" })]);
    expect(models[0].voices).toHaveLength(30);
    expect(models[0].voices).toContain("Kore");

    await env.call("PATCH", "/api/settings", { cloudVoice: { providerId: google.id, model: "gemini-3.5-flash-tts", voice: "Kore" } });
    const res = await env.call("POST", "/api/voice/speak", { text: "Привет из облака." });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    const wav = Buffer.from(await res.arrayBuffer());
    expect(wav.readUInt32LE(24)).toBe(24000);
    // The sound alone, without the credentials; it fades out instead of ending on a click.
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.indexOf("C2PA")).toBe(-1);
    expect(wav.readInt16LE(wav.length - 2)).toBe(0);
    const asked = fake.requests.find((r) => r.path.endsWith(":generateContent"))!.body;
    expect(asked.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
  });

  it("lists an aggregator's speech models with their voices and reads through its /audio/speech, passing on refusals", async () => {
    let refuse = false;
    fake = await startFakeProvider({
      authorized: (h) => h.authorization === `Bearer ${KEY}`,
      handle: (method, path, body) => {
        if (method === "GET" && path === "/v1/models")
          return {
            json: {
              data: [
                // Voices listed in the catalog, as OpenRouter does; free.
                { id: "heygen/heygen-voice-1-turbo:free", name: "HeyGen Voice 1 Turbo (free)", architecture: { output_modalities: ["speech"] }, pricing: { prompt: "0" }, supported_voices: ["nadine", "bram"] },
                // Voices not listed, as RouterAI does: known by the family; Gemini speaks PCM only.
                { id: "google/gemini-3.8-flash-tts", name: "Google: Gemini 3.8 Flash TTS", architecture: { output_modalities: ["speech"] }, pricing: { prompt: 0.000001 } },
                // Voices nobody knows: left out.
                { id: "fish-audio/s2-pro", name: "Fish Audio: S2 Pro", architecture: { output_modalities: ["speech"] } },
                // Not a speech model.
                { id: "chat-model", architecture: { output_modalities: ["text"] } },
              ],
            },
          };
        if (method === "POST" && path === "/v1/audio/speech") {
          if (refuse) return { status: 402, json: { error: { message: "Insufficient credits" } } };
          return body.response_format === "pcm" ? { bytes: Buffer.alloc(480, 2), contentType: "audio/pcm" } : { bytes: Buffer.from("ID3-mp3-bytes"), contentType: "audio/mpeg" };
        }
        return undefined;
      },
    });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", name: "Агрегатор", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const models = await (await env.call("GET", "/api/voice/cloud")).json();
    expect(models.map((m: any) => [m.model, m.provider, m.free, m.voices.length])).toEqual([
      ["heygen/heygen-voice-1-turbo:free", "Агрегатор", true, 2],
      ["google/gemini-3.8-flash-tts", "Агрегатор", false, 30],
    ]);

    await env.call("PATCH", "/api/settings", { cloudVoice: { providerId: provider.id, model: "heygen/heygen-voice-1-turbo:free", voice: "bram" } });
    const mp3 = await env.call("POST", "/api/voice/speak", { text: "Привет" });
    expect(mp3.status).toBe(200);
    expect(mp3.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await mp3.arrayBuffer()).toString()).toBe("ID3-mp3-bytes");
    expect(fake.requests.filter((r) => r.path === "/v1/audio/speech").at(-1)!.body).toEqual({ model: "heygen/heygen-voice-1-turbo:free", voice: "bram", input: "Привет", response_format: "mp3" });

    await env.call("PATCH", "/api/settings", { cloudVoice: { providerId: provider.id, model: "google/gemini-3.8-flash-tts", voice: "Kore" } });
    const wav = await env.call("POST", "/api/voice/speak", { text: "Привет" });
    expect(wav.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await wav.arrayBuffer()).subarray(0, 4).toString()).toBe("RIFF");
    expect(fake.requests.filter((r) => r.path === "/v1/audio/speech").at(-1)!.body.response_format).toBe("pcm");

    refuse = true;
    const refused = await env.call("POST", "/api/voice/speak", { text: "Привет" });
    expect(refused.status).toBe(502);
    expect((await refused.json()).error.detail).toContain("Insufficient credits");
  });

  // Groq, Together and DeepInfra list their speech models without saying what they make: known by the name, with the
  // voices of their family; some speak PCM only and say so, and are asked again in PCM.
  it("finds speech models a catalog does not mark, and asks again in PCM when told to", async () => {
    fake = await startFakeProvider({
      authorized: (h) => h.authorization === `Bearer ${KEY}`,
      handle: (method, path, body) => {
        if (method === "GET" && path === "/v1/models") return { json: { data: [{ id: "canopylabs/orpheus-v1-english" }, { id: "hexgrad/Kokoro-82M" }, { id: "llama-3.3-70b" }, { id: "whisper-large-v3" }] } };
        if (method === "POST" && path === "/v1/audio/speech")
          return body.response_format === "mp3" ? { status: 400, json: { error: { message: 'This model only supports response_format "pcm".' } } } : { bytes: Buffer.alloc(480, 3), contentType: "audio/pcm" };
        return undefined;
      },
    });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const models = await (await env.call("GET", "/api/voice/cloud")).json();
    expect(models.map((m: any) => [m.model, m.voices[0]])).toEqual([
      ["canopylabs/orpheus-v1-english", "autumn"],
      ["hexgrad/Kokoro-82M", "af_heart"],
    ]);
    await env.call("PATCH", "/api/settings", { cloudVoice: { providerId: provider.id, model: "canopylabs/orpheus-v1-english", voice: "autumn" } });
    const res = await env.call("POST", "/api/voice/speak", { text: "Hello" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(fake.requests.filter((r) => r.path === "/v1/audio/speech").map((r) => r.body.response_format)).toEqual(["mp3", "pcm"]);
  });
});
