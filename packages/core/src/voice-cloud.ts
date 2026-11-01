import type { Connection } from "./providers/repo";

/** Gemini's speech models answer raw 16-bit PCM at this rate, mono. */
const GEMINI_RATE = 24_000;
/** When the provider does not list its speech models. */
const GEMINI_FALLBACK = "gemini-2.5-flash-preview-tts";
const OPENAI_MODEL = "gpt-4o-mini-tts";

/** Which speech model of Gemini to use, by the provider's own list, per key. */
const geminiModels = new Map<string, string>();

/** A WAV around raw 16-bit mono PCM. */
export function wavOf(pcm: Buffer, rate: number): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/** The newest Flash speech model the key can use: Flash is quick and has a free tier. */
async function geminiModel(conn: Connection, signal: AbortSignal): Promise<string> {
  const known = geminiModels.get(conn.cacheKey);
  if (known) return known;
  const res = await conn.fetch(`${conn.baseUrl}/models?pageSize=1000`, { headers: { "x-goog-api-key": conn.apiKey ?? "" }, signal }).catch(() => null);
  const names = res?.ok ? ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name.replace(/^models\//, "")) ?? [] : [];
  const version = (n: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(n)?.[1] ?? 0);
  const speech = names.filter((n) => /tts/.test(n)).sort((a, b) => Number(/flash/.test(b)) - Number(/flash/.test(a)) || version(b) - version(a));
  const model = speech[0] ?? GEMINI_FALLBACK;
  if (res?.ok) geminiModels.set(conn.cacheKey, model);
  return model;
}

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return new Error(body?.error?.message ?? `HTTP ${res.status}`);
}

/**
 * An answer read aloud by a provider's voice (asked for: voices from the cloud for reading answers): Gemini's speech
 * models or OpenAI's, as a WAV. Paid by the provider's prices; Gemini's Flash has a free tier.
 */
export async function speakCloud(conn: Connection, voice: string, text: string): Promise<Buffer> {
  const signal = AbortSignal.timeout(90_000);
  if (conn.preset === "google") {
    const model = await geminiModel(conn, signal);
    const res = await conn.fetch(`${conn.baseUrl}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": conn.apiKey ?? "" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
      signal,
    });
    if (!res.ok) throw await failure(res);
    const body = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] };
    const audio = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (!audio?.data) throw new Error("The provider sent no sound.");
    const rate = Number(/rate=(\d+)/.exec(audio.mimeType ?? "")?.[1] ?? GEMINI_RATE);
    return wavOf(Buffer.from(audio.data, "base64"), rate);
  }
  if (conn.preset === "openai") {
    const res = await conn.fetch(`${conn.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${conn.apiKey ?? ""}` },
      body: JSON.stringify({ model: OPENAI_MODEL, voice, input: text, response_format: "wav" }),
      signal,
    });
    if (!res.ok) throw await failure(res);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`No voices from ${conn.preset}.`);
}
