import { speechText } from "@drimvox/shared";
/** Models take WAV and MP3, not the browser's own WebM: the recording is turned into 16 kHz mono WAV. */
const RATE = 16_000;

function wavOf(samples: Float32Array): Blob {
  const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  data.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, RATE, true);
  data.setUint32(28, RATE * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, "data");
  data.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([data.buffer], { type: "audio/wav" });
}

async function toWav(recorded: Blob): Promise<Blob> {
  const decoded = await new AudioContext().decodeAudioData(await recorded.arrayBuffer());
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * RATE), RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return wavOf((await offline.startRendering()).getChannelData(0));
}

/** Starts recording from the microphone; the returned function stops it and gives the WAV as base64. */
export async function startRecording(): Promise<() => Promise<string>> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.start();
  return () =>
    new Promise<string>((resolve, reject) => {
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        try {
          const wav = await toWav(new Blob(chunks, { type: recorder.mimeType }));
          const bytes = new Uint8Array(await wav.arrayBuffer());
          let binary = "";
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          resolve(btoa(binary));
        } catch (err) {
          reject(err);
        }
      };
      recorder.stop();
    });
}

/** The words of an answer to read aloud: no emoji, code, addresses or symbols (asked for). */
export function plainText(text: string): string {
  return speechText(text);
}

/**
 * Plays a WAV that a voice on this computer read (Piper, docs/specs/local-speech.md); `wav` fetches it. Resolves to a
 * way to stop; falls back to the system's voice when the recording does not come.
 */
export function speakWav(wav: () => Promise<Blob>, fallback: () => () => void, onEnd: () => void): () => void {
  let stopped = false;
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;
  let stopFallback: (() => void) | null = null;
  const end = () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
    onEnd();
  };
  void wav()
    .then((blob) => {
      if (stopped) return;
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      audio.onended = end;
      audio.onerror = end;
      return audio.play();
    })
    .catch(() => {
      if (!stopped) stopFallback = fallback();
    });
  return () => {
    stopped = true;
    audio?.pause();
    stopFallback?.();
    end();
  };
}

/** Reads a text aloud with the system's voices, in the interface's language; Markdown marks are left out. */
export function speak(text: string, locale: string, onEnd: () => void): () => void {
  const plain = plainText(text);
  const utterance = new SpeechSynthesisUtterance(plain);
  utterance.lang = locale === "ru" ? "ru-RU" : "en-US";
  // A natural (neural) voice where the system has one: the plain ones sound like a robot (seen: Windows' Irina).
  const own = speechSynthesis.getVoices().filter((v) => v.lang.startsWith(utterance.lang.slice(0, 2)));
  const voice = own.find((v) => /natural|neural|online/i.test(v.name)) ?? own[0];
  if (voice) utterance.voice = voice;
  utterance.onend = onEnd;
  utterance.onerror = onEnd;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
  return () => {
    speechSynthesis.cancel();
    onEnd();
  };
}
