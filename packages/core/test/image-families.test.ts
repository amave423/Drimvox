import { describe, expect, it } from "vitest";
import { familyOf, foundModel, IMAGE_MODELS } from "../src/local/images/catalog";

// Seen live: Qwen-Image 2.1 from Comfy-Org, taken as Qwen-Image 2512, got 2512's text encoder (Qwen2.5-VL 7B) and VAE;
// the engine stopped while loading it ("new_sd_ctx_t failed": the encoder's layers had the wrong shapes). 2.1 has its
// own: Qwen3-VL 8B and qwen_image_2.1_vae (stable-diffusion.cpp's docs/models/qwen_image_2.1.md).
describe("the family of a model found on Hugging Face", () => {
  it("tells Qwen-Image 2.1 from the earlier Qwen-Image", () => {
    expect(familyOf("Comfy-Org/Qwen-Image-2.1/diffusion_models/qwen_image_2.1_int8_convrot.safetensors")).toBe("qwen-image-2.1");
    expect(familyOf("leejet/Qwen-Image-2.1-GGUF/qwen_image_2.1-Q4_K.gguf")).toBe("qwen-image-2.1");
    expect(familyOf("unsloth/Qwen-Image-2512-GGUF/qwen-image-2512-Q4_K_S.gguf")).toBe("qwen-image-2512");
    expect(familyOf("Qwen/Qwen-Image-Edit-2511")).toBeNull();
  });

  it("gives Qwen-Image 2.1 its own text encoder, VAE and settings", () => {
    const family = IMAGE_MODELS.find((m) => m.id === "qwen-image-2.1")!;
    const found = foundModel(family, "Comfy-Org/Qwen-Image-2.1", "diffusion_models/qwen_image_2.1_int8_convrot.safetensors", 7_256_783_064);
    const files = found.variants[0]!;
    expect(files.find((f) => f.role === "llm")).toMatchObject({ repo: "Qwen/Qwen3-VL-8B-Instruct-GGUF" });
    expect(files.find((f) => f.role === "vae")).toMatchObject({ repo: "Comfy-Org/Qwen-Image-2.1", path: "vae/qwen_image_2.1_vae_bf16.safetensors" });
    expect(found.settings).toMatchObject({ cfg: 6, sampler: "euler" });
  });

  it("keeps it out of the short list, which holds only models checked with the engine", () => {
    expect(IMAGE_MODELS.find((m) => m.id === "qwen-image-2.1")?.listed).toBe(false);
  });
});
