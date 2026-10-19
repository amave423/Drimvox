import type { LocalFit, LocalHardware, LocalImageModelId } from "@artel/shared";
import { fitOf } from "../fit";

const MB = 2 ** 20;

/** What a file is for: the server takes each one under its own option. */
export type ImageFileRole = "diffusion" | "vae" | "llm";

export interface ImageFile {
  role: ImageFileRole;
  repo: string;
  /** The path inside the repository, as Hugging Face lists it. */
  path: string;
  /** About this big: for the size shown and the fit. The real size and checksum come from Hugging Face. */
  bytes: number;
}

/** How a model draws: the defaults its authors give for stable-diffusion.cpp. */
export interface ImageSettings {
  steps: number;
  cfg: number;
  flowShift?: number;
  sampler?: string;
}

export interface ImageModelDef {
  id: LocalImageModelId;
  name: string;
  /** From the best to the smallest: the best one this computer runs fast is taken, else the smallest that runs. */
  variants: ImageFile[][];
  settings: ImageSettings;
}

const zImageVae: ImageFile = { role: "vae", repo: "Comfy-Org/z_image_turbo", path: "split_files/vae/ae.safetensors", bytes: 320 * MB };

/** The short list (docs/specs/local-images.md): each model checked with the engine Artel downloads. */
export const IMAGE_MODELS: ImageModelDef[] = [
  {
    id: "z-image-turbo",
    name: "Z-Image Turbo",
    variants: [
      [
        { role: "diffusion", repo: "leejet/Z-Image-Turbo-GGUF", path: "z_image_turbo-Q8_0.gguf", bytes: 6273 * MB },
        { role: "llm", repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF", path: "Qwen3-4B-Instruct-2507-Q8_0.gguf", bytes: 4082 * MB },
        zImageVae,
      ],
      [
        { role: "diffusion", repo: "leejet/Z-Image-Turbo-GGUF", path: "z_image_turbo-Q4_K.gguf", bytes: 3685 * MB },
        { role: "llm", repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF", path: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", bytes: 2382 * MB },
        zImageVae,
      ],
    ],
    settings: { steps: 8, cfg: 1 },
  },
  {
    id: "qwen-image-2512",
    name: "Qwen-Image 2512",
    variants: [
      [
        { role: "diffusion", repo: "unsloth/Qwen-Image-2512-GGUF", path: "qwen-image-2512-Q4_K_S.gguf", bytes: 11700 * MB },
        { role: "llm", repo: "unsloth/Qwen2.5-VL-7B-Instruct-GGUF", path: "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf", bytes: 4466 * MB },
        { role: "vae", repo: "Comfy-Org/Qwen-Image_ComfyUI", path: "split_files/vae/qwen_image_vae.safetensors", bytes: 242 * MB },
      ],
    ],
    settings: { steps: 20, cfg: 2.5, flowShift: 3, sampler: "euler" },
  },
];

export const sizeOf = (files: ImageFile[]) => files.reduce((sum, f) => sum + f.bytes, 0);

/** The files of a model for this computer, and how it runs; null when it does not run here at all. */
export function variantFor(model: ImageModelDef, hw: LocalHardware): { files: ImageFile[]; fit: LocalFit } | null {
  const runs = model.variants.map((files) => ({ files, fit: fitOf(sizeOf(files), hw) })).filter((v): v is { files: ImageFile[]; fit: LocalFit } => v.fit !== null);
  return runs.find((v) => v.fit === "fast") ?? runs.at(-1) ?? null;
}

/** The pictures' sides for each aspect ratio: about a megapixel, multiples of 64. */
export const IMAGE_SIZES: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "4:3": [1152, 896],
  "3:4": [896, 1152],
};

/** Where the downloaded file of a model lives: by repository, so a file two models share is downloaded once. */
export const fileKey = (f: ImageFile) => `${f.repo.replace("/", "__")}__${f.path.replace(/\//g, "__")}`;
