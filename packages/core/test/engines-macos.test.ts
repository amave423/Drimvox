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

describe("a type of service the system refuses", () => {
  it("does not throw out of a request's socket (seen on a Mac: EINVAL from undici on every request)", async () => {
    await import("../src/proxy");
    const { Socket } = await import("node:net");
    const socket = new Socket() as InstanceType<typeof Socket> & { setTypeOfService?: (tos: number) => unknown };
    if (!socket.setTypeOfService) return;
    // Not connected: the system refuses it on every platform, as macOS does on some connected sockets.
    expect(() => socket.setTypeOfService!(0)).not.toThrow();
    socket.destroy();
  });
});
