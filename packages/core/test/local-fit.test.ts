import type { LocalHardware } from "@artel/shared";
import { describe, expect, it } from "vitest";
import { fitOf, GB, recommend } from "../src/local/fit";
import { parseNvidiaSmi, parseWindowsVideo } from "../src/local/hardware";
import { variantsOf } from "../src/local/catalog";

const desktop: LocalHardware = { ramBytes: 32 * GB, gpu: { name: "RTX 3080", vramBytes: 10 * GB }, unified: false };
const laptop: LocalHardware = { ramBytes: 8 * GB, gpu: null, unified: false };
const mac: LocalHardware = { ramBytes: 16 * GB, gpu: null, unified: true };

describe("fitOf", () => {
  it("is fast in video memory, slow with main memory, and nothing when it does not fit at all", () => {
    expect(fitOf(5 * GB, desktop)).toBe("fast");
    expect(fitOf(9 * GB, desktop)).toBe("slow");
    expect(fitOf(17 * GB, desktop)).toBe("slow");
    expect(fitOf(32 * GB, desktop)).toBeNull();
  });

  it("runs everything on the processor without a video card", () => {
    expect(fitOf(2 * GB, laptop)).toBe("slow");
    expect(fitOf(6 * GB, laptop)).toBeNull();
  });

  it("counts Apple's shared memory as video memory", () => {
    expect(fitOf(8 * GB, mac)).toBe("fast");
    expect(fitOf(14 * GB, mac)).toBeNull();
  });
});

describe("recommend", () => {
  const v = (quant: string, gb: number) => ({ quant, sizeBytes: gb * GB, fit: fitOf(gb * GB, desktop)! });

  it("takes the best variant that is fast, but nothing above Q8_0", () => {
    const variants = [v("Q3_K_M", 4), v("Q4_K_M", 5), v("Q6_K", 7), v("Q8_0", 8.5), v("BF16", 16)];
    expect(recommend(variants)?.quant).toBe("Q6_K");
  });

  it("takes the smallest when none is fast", () => {
    const variants = [v("Q4_K_M", 16), v("Q3_K_M", 13), v("Q6_K", 22)];
    expect(recommend(variants)?.quant).toBe("Q3_K_M");
  });

  it("knows Unsloth's dynamic variants by their base quantization", () => {
    expect(recommend([v("UD-Q4_K_XL", 5), v("UD-IQ2_XXS", 3)])?.quant).toBe("UD-Q4_K_XL");
  });
});

describe("hardware", () => {
  it("reads the largest NVIDIA card", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 3060, 12288\nNVIDIA GeForce RTX 3080, 10240\n")).toEqual({ name: "NVIDIA GeForce RTX 3060", vramBytes: 12288 * 2 ** 20 });
    expect(parseNvidiaSmi("NVIDIA-SMI has failed")).toBeNull();
  });

  it("reads video memory of other cards from the Windows driver registry", () => {
    const out = JSON.stringify([
      { DriverDesc: "Intel(R) UHD Graphics", VRAM: 134217728 },
      { DriverDesc: "AMD Radeon RX 7800 XT", VRAM: 17163091968 },
      { DriverDesc: "Microsoft Basic Display Adapter", VRAM: null },
    ]);
    expect(parseWindowsVideo(out)).toEqual({ name: "AMD Radeon RX 7800 XT", vramBytes: 17163091968 });
    expect(parseWindowsVideo(JSON.stringify({ DriverDesc: "Intel(R) UHD Graphics", VRAM: 134217728 }))).toEqual({
      name: "Intel(R) UHD Graphics",
      vramBytes: 134217728,
    });
    expect(parseWindowsVideo("")).toBeNull();
  });
});

describe("variantsOf", () => {
  const file = (path: string, gb: number) => ({ type: "file", path, size: Math.round(gb * GB) });
  const tree = [
    { type: "directory", path: "BF16", size: 0 },
    file("README.md", 0.00001),
    file("Model-12B-Q4_K_M.gguf", 7),
    file("Model-12B-Q8_0.gguf", 12.5),
    file("Model-12B-UD-Q5_K_XL.gguf", 8.6),
    file("Model-12B-Q3_K_M.gguf", 5.8),
    file("mmproj-F16.gguf", 0.8),
    file("imatrix_unsloth.gguf", 0.01),
    file("Model-12B-Q6_K-00001-of-00002.gguf", 5),
    file("Model-12B-BF16.gguf", 23),
    file("Model-12B-F32.gguf", 46),
  ];

  it("lists the files Ollama can pull, with sizes, fit and the advice", () => {
    const variants = variantsOf("unsloth/Model-12B-GGUF", tree, desktop, []);
    expect(variants.map((v) => [v.quant, v.fit, v.recommended])).toEqual([
      ["Q3_K_M", "fast", false],
      ["Q4_K_M", "fast", true],
      ["UD-Q5_K_XL", "slow", false],
      ["Q8_0", "slow", false],
      ["BF16", "slow", false],
    ]);
    expect(variants[1]).toMatchObject({ file: "Model-12B-Q4_K_M.gguf", model: "hf.co/unsloth/Model-12B-GGUF:Q4_K_M", installed: false });
  });

  it("marks what is already downloaded", () => {
    const variants = variantsOf("unsloth/Model-12B-GGUF", tree, desktop, ["hf.co/unsloth/Model-12B-GGUF:Q4_K_M"]);
    expect(variants.find((v) => v.quant === "Q4_K_M")?.installed).toBe(true);
  });
});
