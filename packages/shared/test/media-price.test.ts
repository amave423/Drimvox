import { describe, expect, it } from "vitest";
import { estimateCost, needsConfirmation, type MediaModel } from "../src/media";

const image = (lines: { billable: string; unit: string; costUsd: number; variant?: string }[], extra: Partial<MediaModel> = {}): MediaModel => ({
  id: "x/img",
  name: "Img",
  kind: "image",
  aspectRatios: ["1:1"],
  resolutions: [],
  durations: [],
  audio: false,
  pricing: { lines: lines.map((l) => ({ variant: null, ...l })), skus: {} },
  ...extra,
});

const video = (skus: Record<string, string>, extra: Partial<MediaModel> = {}): MediaModel => ({
  id: "x/vid",
  name: "Vid",
  kind: "video",
  aspectRatios: ["16:9"],
  resolutions: ["720p", "1080p"],
  durations: [8, 4, 6],
  audio: true,
  pricing: { lines: [], skus },
  ...extra,
});

describe("image prices", () => {
  it("takes a flat price per image", () => {
    expect(estimateCost(image([{ billable: "output_image", unit: "image", costUsd: 0.018 }, { billable: "input_image", unit: "image", costUsd: 0 }]), {})).toBe(0.018);
  });

  it("picks the variant for the chosen resolution, 1K by default", () => {
    const flux = image([
      { billable: "output_image", unit: "image", costUsd: 0.041, variant: "768" },
      { billable: "output_image", unit: "image", costUsd: 0.048, variant: "1k" },
      { billable: "output_image", unit: "image", costUsd: 0.1, variant: "2k" },
    ]);
    expect(estimateCost(flux, {})).toBe(0.048);
    expect(estimateCost(flux, { resolution: "2K" })).toBe(0.1);
  });

  it("takes the dearest quality when variants carry a quality prefix", () => {
    const grok = image([
      { billable: "output_image", unit: "image", costUsd: 0.04, variant: "low_1k" },
      { billable: "output_image", unit: "image", costUsd: 0.06, variant: "medium_1k" },
      { billable: "output_image", unit: "image", costUsd: 0.06, variant: "low_2k" },
    ]);
    expect(estimateCost(grok, {})).toBe(0.06);
  });

  it("prices megapixels and tokens by the size of the picture", () => {
    expect(estimateCost(image([{ billable: "output_image", unit: "megapixel", costUsd: 0.03 }]), {})).toBeCloseTo(0.0315, 4);
    expect(estimateCost(image([{ billable: "output_image", unit: "token", costUsd: 0.00003 }]), {})).toBeCloseTo(0.039, 4);
    expect(estimateCost(image([{ billable: "output_image", unit: "token", costUsd: 0.00003 }]), { resolution: "2K" })).toBeCloseTo(0.156, 4);
  });

  it("does not know the price without an output line", () => {
    expect(estimateCost(image([]), {})).toBeNull();
    expect(estimateCost(image([{ billable: "input_image", unit: "image", costUsd: 0.01 }]), {})).toBeNull();
  });
});

describe("video prices", () => {
  it("multiplies the per-second price for the resolution and sound by the duration", () => {
    const veo = video({
      duration_seconds_with_audio: "0.08",
      duration_seconds_without_audio: "0.05",
      duration_seconds_with_audio_720p: "0.05",
      duration_seconds_without_audio_720p: "0.03",
    });
    // Defaults: the shortest duration, the first resolution, no sound.
    expect(estimateCost(veo, {})).toBeCloseTo(0.12, 6);
    expect(estimateCost(veo, { duration: 8, resolution: "1080p", audio: true })).toBeCloseTo(0.64, 6);
  });

  it("reads prices in cents and applies a minimum per generation", () => {
    expect(estimateCost(video({ cents_per_video_output_second_720p: "3", cents_per_image_input: "1" }), { duration: 4 })).toBeCloseTo(0.12, 6);
    expect(estimateCost(video({ cents_per_second_output: "28", minimum_cents_per_generation: "56" }), { duration: 1 })).toBeCloseTo(0.56, 6);
  });

  it("counts video tokens from the frame size", () => {
    // 1280 × 720 × 24 fps × 4 s / 1024 = 86 400 tokens.
    expect(estimateCost(video({ video_tokens: "0.0000107" }), { duration: 4 })).toBeCloseTo(0.92448, 5);
  });

  it("does not know prices it cannot read", () => {
    expect(estimateCost(video({ cents_per_megapixel_second_precise: "7.5" }), {})).toBeNull();
  });
});

describe("confirmation", () => {
  it("asks before any video, anything dearer than 10 cents and anything without a price", () => {
    const cheap = image([{ billable: "output_image", unit: "image", costUsd: 0.04 }]);
    expect(needsConfirmation(cheap, 0.04)).toBe(false);
    expect(needsConfirmation(cheap, 0.12)).toBe(true);
    expect(needsConfirmation(cheap, null)).toBe(true);
    expect(needsConfirmation(video({ duration_seconds: "0.001" }), 0.004)).toBe(true);
  });
});
