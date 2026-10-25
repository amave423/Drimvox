import { findProgram, installArchive } from "../archive";

/**
 * The Piper build Drimvox uses (docs/specs/local-speech.md): its last release as one program with its libraries and
 * espeak-ng's data, pinned. The project is archived; the build stays on GitHub.
 */
export const PIPER_TAG = "2023.11.14-2";
const RELEASES = "https://github.com/rhasspy/piper/releases/download";

export function piperUrl(platform: string = process.platform, arch: string = process.arch): string | null {
  const asset =
    platform === "win32" && arch === "x64"
      ? "piper_windows_amd64.zip"
      : platform === "linux" && arch === "x64"
        ? "piper_linux_x86_64.tar.gz"
        : platform === "linux" && arch === "arm64"
          ? "piper_linux_aarch64.tar.gz"
          : null;
  return asset ? `${RELEASES}/${PIPER_TAG}/${asset}` : null;
}

const PROGRAM = ["piper.exe", "piper"];

export function findPiper(dir: string): string | null {
  return findProgram(dir, PROGRAM);
}

export function installPiper(o: { url: string; dir: string; fetch: typeof fetch; signal: AbortSignal; progress(received: number, total: number): void }): Promise<string> {
  return installArchive({ ...o, programs: PROGRAM });
}
