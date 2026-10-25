import { findProgram, installArchive } from "../archive";

/** The whisper.cpp build Drimvox uses (docs/specs/local-audio.md): pinned, a newer one changes nothing until checked. */
export const WHISPER_TAG = "b5130";
const RELEASES = "https://github.com/ggml-org/whisper.cpp/releases/download";

/** The processor build for Windows and Linux: it runs on any computer, and speech is quick enough without a video card. */
export function whisperUrl(platform: string = process.platform, arch: string = process.arch): string | null {
  const asset = platform === "win32" && arch === "x64" ? "whisper-bin-x64.zip" : platform === "linux" && arch === "x64" ? "whisper-bin-ubuntu-x64.tar.gz" : null;
  return asset ? `${RELEASES}/${WHISPER_TAG}/${asset}` : null;
}

const CLI = ["whisper-cli.exe", "whisper-cli"];

/** The command-line program in an unpacked engine, wherever the archive put it; null when there is none. */
export function findCli(dir: string): string | null {
  return findProgram(dir, CLI);
}

/** Downloads the engine's archive and unpacks it into `dir`; resolves with the program. Half-unpacked never counts. */
export function installWhisper(o: { url: string; dir: string; fetch: typeof fetch; signal: AbortSignal; progress(received: number, total: number): void }): Promise<string> {
  return installArchive({ ...o, programs: CLI });
}
