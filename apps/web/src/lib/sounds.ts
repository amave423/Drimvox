import type { Settings } from "@drimvox/shared";

export type NoticeSound = Settings["notifySound"];

/** One tone of a sound: its pitch, when it starts, how long it rings, its shape and loudness. */
interface Tone {
  hz: number;
  at: number;
  ring: number;
  wave: OscillatorType;
  gain: number;
  /** A pitch it slides to while it rings: a drop falls, a pop rises. */
  to?: number;
}

/**
 * Drimvox's own notification sounds (asked for: its own, and the app sold without breaking anyone's rights): made here
 * from plain tones, so there is no recording and nobody else's work in them.
 */
const SOUNDS: Record<Exclude<NoticeSound, "off">, Tone[]> = {
  // Two quick high notes, the second higher, like a drop.
  drop: [
    { hz: 1046.5, at: 0, ring: 0.16, wave: "sine", gain: 0.9, to: 880 },
    { hz: 1568, at: 0.09, ring: 0.32, wave: "sine", gain: 0.7 },
  ],
  // A small bell: a fifth with an overtone each, ringing out.
  chime: [
    { hz: 1318.5, at: 0, ring: 0.9, wave: "sine", gain: 0.6 },
    { hz: 2637, at: 0, ring: 0.4, wave: "sine", gain: 0.15 },
    { hz: 1975.5, at: 0.12, ring: 1.1, wave: "sine", gain: 0.5 },
    { hz: 3951, at: 0.12, ring: 0.45, wave: "sine", gain: 0.1 },
  ],
  // Low and round: a soft chord.
  soft: [
    { hz: 523.25, at: 0, ring: 0.6, wave: "triangle", gain: 0.6 },
    { hz: 659.25, at: 0.05, ring: 0.6, wave: "triangle", gain: 0.45 },
    { hz: 783.99, at: 0.1, ring: 0.7, wave: "triangle", gain: 0.4 },
  ],
  // One short rising blip.
  pop: [{ hz: 620, at: 0, ring: 0.12, wave: "sine", gain: 1, to: 1240 }],
};

let context: AudioContext | null = null;

/** Plays a notification sound at `volume` (0 to 1); quietly does nothing where sound cannot be made. */
export function playSound(sound: NoticeSound, volume: number): void {
  if (sound === "off" || volume <= 0) return;
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume();
    const now = context.currentTime + 0.02;
    const master = context.createGain();
    master.gain.value = Math.min(1, volume) * 0.35;
    master.connect(context.destination);
    for (const tone of SOUNDS[sound]) {
      const osc = context.createOscillator();
      const env = context.createGain();
      osc.type = tone.wave;
      osc.frequency.setValueAtTime(tone.hz, now + tone.at);
      if (tone.to) osc.frequency.exponentialRampToValueAtTime(tone.to, now + tone.at + tone.ring * 0.6);
      // A quick start and a long fall: struck, not switched on.
      env.gain.setValueAtTime(0.0001, now + tone.at);
      env.gain.exponentialRampToValueAtTime(tone.gain, now + tone.at + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, now + tone.at + tone.ring);
      osc.connect(env).connect(master);
      osc.start(now + tone.at);
      osc.stop(now + tone.at + tone.ring + 0.05);
    }
  } catch {
    // No audio here: the notification is seen without a sound.
  }
}
