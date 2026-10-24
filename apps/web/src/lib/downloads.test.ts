import type { LocalImagesStatus, LocalPull, LocalStatus } from "@drimvox/shared";
import { describe, expect, it } from "vitest";
import { activeDownloads } from "../ui/DownloadNote";

const pull = (o: Partial<LocalPull>): LocalPull => ({ model: "m", status: "downloading", completed: 5, total: 10, done: false, error: null, paused: false, bytesPerSecond: 1, ...o });

describe("the downloads the bottom bar shows", () => {
  it("are the ones going on now, of chat models, picture models and the engine", () => {
    const local = { pulls: [pull({ model: "gemma4:e4b" }), pull({ model: "old", done: true }), pull({ model: "held", paused: true }), pull({ model: "bad", error: "x" })] } as LocalStatus;
    const images = { models: [{ name: "Z-Image Turbo", pull: pull({}) }, { name: "Idle", pull: null }], enginePull: pull({}) } as unknown as LocalImagesStatus;
    expect(activeDownloads(local, images).map((d) => d.name)).toEqual(["gemma4:e4b", "Z-Image Turbo", "stable-diffusion.cpp"]);
    expect(activeDownloads(null, null)).toEqual([]);
  });
});
