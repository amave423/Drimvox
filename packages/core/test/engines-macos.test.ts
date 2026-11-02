import { describe, expect, it } from "vitest";
import { whisperUrl } from "../src/local/audio/engine";
import { engineUrl } from "../src/local/images/engine";
import { piperUrl } from "../src/local/speech/engine";

// docs/specs/macos.md: which engines on this computer a Mac gets.
describe("engines on macOS", () => {
  it("downloads Piper's own Mac builds, Apple Silicon and Intel", () => {
    expect(piperUrl("darwin", "arm64")).toMatch(/piper_macos_aarch64\.tar\.gz$/);
    expect(piperUrl("darwin", "x64")).toMatch(/piper_macos_x64\.tar\.gz$/);
  });

  it("has pictures on Apple Silicon, and no whisper.cpp build to download (speech goes to a cloud model)", () => {
    expect(engineUrl("darwin", "arm64")).toBeTruthy();
    expect(whisperUrl("darwin", "arm64")).toBeNull();
  });
});
