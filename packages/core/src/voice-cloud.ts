import type { CloudSpeechModel } from "@drimvox/shared";
import type { Connection } from "./providers/repo";

/** Gemini's speech models answer raw 16-bit PCM at this rate, mono. */
const PCM_RATE = 24_000;

const GEMINI = ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"];

/**
 * Voices of model families whose catalog entry does not list them (RouterAI's, OpenAI's, Google's own), by the model's
 * id. Catalogs that list them (OpenRouter's `supported_voices`) are taken as they are.
 */
const FAMILIES: [RegExp, string[]][] = [
  [/gemini.*tts/i, GEMINI],
  [/(^|\/)(gpt-[\w.-]*tts|tts-1(-hd)?)$/i, ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"]],
  [/grok.*(voice|tts)/i, ["eve", "ara", "rex", "sal", "leo"]],
  [/^elevenlabs\//i, ["george", "sarah", "adam", "alice", "bella", "bill", "brian", "callum", "charlie", "chris", "daniel", "eric", "harry", "jessica", "laura", "liam", "lily", "matilda", "river", "roger", "will"]],
  [/^heygen\//i, ["nadine", "tabitha", "bram", "gareth", "noelle", "meredith", "sabrina", "lucian", "weston", "vincent"]],
  [/kokoro/i, ["af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "am_adam", "am_michael", "am_eric", "bf_emma", "bf_isabella", "bm_george", "bm_lewis", "ef_dora", "em_alex", "ff_siwis", "if_sara", "im_nicola", "pf_dora", "pm_alex", "jf_alpha", "zf_xiaoxiao", "zm_yunxi"]],
  [/voxtral.*tts/i, ["en_paul_neutral", "en_paul_cheerful", "en_paul_confident", "gb_oliver_neutral", "gb_oliver_cheerful", "gb_jane_neutral", "gb_jane_confident", "fr_marie_neutral", "fr_marie_happy"]],
  // Groq's Orpheus has its own voices; Canopy's own and the others' have these.
  [/orpheus-v1/i, ["autumn", "diana", "hannah", "austin", "daniel", "troy"]],
  [/orpheus/i, ["tara", "leah", "jess", "leo", "dan", "mia", "zac"]],
];

/** Speech models by name, where the catalog does not say what a model makes. */
const SPEECH_ID = /(^|[/-])tts([-.]|$)|tts-1|orpheus|kokoro/i;

/** Providers that never have voices: on this computer, by subscription, or a chain of chat models. */
const NO_VOICES = new Set(["ollama", "lmstudio", "sdcpp", "whispercpp", "anthropic", "deepseek"]);
/** What each provider's catalog said, for a while: the settings list opens often, the catalogs change seldom. */
const listed = new Map<string, { at: number; models: Omit<CloudSpeechModel, "providerId" | "provider">[] }>();
const LISTED_MS = 30 * 60_000;

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

/**
 * The sound alone: Google appends its content credentials (a C2PA "jumb" box) to the raw PCM, which played as sound is a
 * blast of noise at the end (seen: "a loud sound like a walkie-talkie" after every answer). Cut there, with a short fade
 * so the voice does not end on a click.
 */
export function cleanPcm(pcm: Buffer, rate: number): Buffer {
  let end = pcm.length;
  for (let at = pcm.indexOf("C2PA"); at >= 0; at = pcm.indexOf("C2PA", at + 1)) {
    if (pcm.indexOf("jumb", at) - at < 64 && pcm.indexOf("jumb", at) > at) {
      end = at;
      break;
    }
  }
  const out = Buffer.from(pcm.subarray(0, end - (end % 2)));
  const samples = out.length / 2;
  const fade = Math.min(samples, Math.round(rate * 0.015));
  for (let i = 0; i < fade; i++) {
    const at = (samples - fade + i) * 2;
    out.writeInt16LE(Math.round(out.readInt16LE(at) * (1 - (i + 1) / fade)), at);
  }
  return out;
}

const familyVoices = (id: string) => FAMILIES.find(([pattern]) => pattern.test(id))?.[1] ?? null;
/** Gemini's speech models answer PCM only. */
const pcmOnly = (id: string) => /gemini/i.test(id);

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return new Error(body?.error?.message ?? `HTTP ${res.status}`);
}

interface CatalogEntry {
  id: string;
  name?: string;
  architecture?: { output_modalities?: string[] };
  pricing?: { prompt?: string | number };
  supported_voices?: unknown;
  /** Together marks its models with a type. */
  type?: string;
}

/** The speech models of one provider, from its own catalog, with their voices; none when it has no such models. */
async function catalog(conn: Connection): Promise<Omit<CloudSpeechModel, "providerId" | "provider">[]> {
  const signal = AbortSignal.timeout(15_000);
  if (conn.preset === "google") {
    const res = await conn.fetch(`${conn.baseUrl}/models?pageSize=1000`, { headers: { "x-goog-api-key": conn.apiKey ?? "" }, signal });
    if (!res.ok) throw await failure(res);
    const models = ((await res.json()) as { models?: { name: string; displayName?: string }[] }).models ?? [];
    return models.filter((m) => /tts/i.test(m.name)).map((m) => ({ model: m.name.replace(/^models\//, ""), name: m.displayName ?? m.name.replace(/^models\//, ""), free: false, voices: GEMINI }));
  }
  // OpenRouter lists its speech models only when asked for them; the others ignore the question and list everything.
  const res = await conn.fetch(`${conn.baseUrl}/models?output_modalities=speech`, {
    headers: { authorization: `Bearer ${conn.apiKey ?? ""}`, ...(conn.preset === "openrouter" ? { "X-Title": "Drimvox" } : {}) },
    signal,
  });
  if (!res.ok) throw await failure(res);
  const entries = ((await res.json()) as { data?: CatalogEntry[] }).data ?? [];
  return entries
    .filter((e) => (e.architecture?.output_modalities ? e.architecture.output_modalities.includes("speech") : e.type === "tts" || SPEECH_ID.test(e.id)))
    .map((e) => {
      const listedVoices = Array.isArray(e.supported_voices) ? e.supported_voices.filter((v): v is string => typeof v === "string") : [];
      return { model: e.id, name: e.name ?? e.id, free: Number(e.pricing?.prompt ?? NaN) === 0, voices: listedVoices.length ? listedVoices : (familyVoices(e.id) ?? []) };
    })
    // A model whose voices are not known cannot be asked to speak (Fish Audio's take voices made by the user).
    .filter((m) => m.voices.length > 0);
}

/** The speech models of a provider, or none; cached for a while per key. */
export async function speechModels(conn: Connection): Promise<Omit<CloudSpeechModel, "providerId" | "provider">[]> {
  if (conn.chain || !conn.apiKey || NO_VOICES.has(conn.preset)) return [];
  const known = listed.get(conn.cacheKey);
  if (known && Date.now() - known.at < LISTED_MS) return known.models;
  const models = await catalog(conn).catch(() => []);
  listed.set(conn.cacheKey, { at: Date.now(), models });
  return models;
}

/** For tests: forget what the catalogs said. */
export function forgetSpeechModels(): void {
  listed.clear();
}

/**
 * An answer read aloud by a provider's voice (asked for: voices from every provider that has them): Google's own API, or
 * the OpenAI-style `/audio/speech` that OpenAI, OpenRouter, RouterAI and others share. Paid by the provider's prices.
 */
export async function speakCloud(conn: Connection, model: string, voice: string, text: string): Promise<{ audio: Buffer; type: string }> {
  const signal = AbortSignal.timeout(90_000);
  if (conn.preset === "google") {
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
    const rate = Number(/rate=(\d+)/.exec(audio.mimeType ?? "")?.[1] ?? PCM_RATE);
    return { audio: wavOf(cleanPcm(Buffer.from(audio.data, "base64"), rate), rate), type: "audio/wav" };
  }
  const ask = (format: "mp3" | "pcm") =>
    conn.fetch(`${conn.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${conn.apiKey ?? ""}`, ...(conn.preset === "openrouter" ? { "X-Title": "Drimvox" } : {}) },
      body: JSON.stringify({ model, voice, input: text, response_format: format }),
      signal,
    });
  let pcm = pcmOnly(model);
  let res = await ask(pcm ? "pcm" : "mp3");
  if (!res.ok && !pcm) {
    // Some speak PCM only, and say so (seen: "HeyGen Voice only supports response_format "pcm"").
    const refused = await failure(res);
    if (!/pcm|response_format|format/i.test(refused.message)) throw refused;
    pcm = true;
    res = await ask("pcm");
  }
  if (!res.ok) throw await failure(res);
  const bytes = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  if (pcm || /pcm|L16/i.test(type)) return { audio: wavOf(cleanPcm(bytes, PCM_RATE), PCM_RATE), type: "audio/wav" };
  return { audio: bytes, type: /^audio\//.test(type) ? type.split(";")[0]! : "audio/mpeg" };
}
