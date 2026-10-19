import type { CheckedImageModelId, LocalFit, LocalHardware } from "@artel/shared";
import { fitOf } from "../fit";

const MB = 2 ** 20;

/** What a file is for: the server takes each one under its own option. */
export type ImageFileRole = "diffusion" | "vae" | "llm" | "t5xxl";

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
  /** What the picture should not have: Wan's authors give a long list in Chinese, and it helps. */
  negative?: string;
  /** Clips: frames a second the model was trained at. */
  fps?: number;
}

export interface ImageModelDef {
  /** A checked model's id, or `hf:<repo>:<path>` for one found on Hugging Face. */
  id: string;
  /** The checked model it is, or whose family it belongs to. */
  family: CheckedImageModelId;
  kind: "image" | "video";
  name: string;
  /** From the best to the smallest: the best one this computer runs fast is taken, else the smallest that runs. */
  variants: ImageFile[][];
  settings: ImageSettings;
}

const wan22Vae: ImageFile = { role: "vae", repo: "Comfy-Org/Wan_2.2_ComfyUI_Repackaged", path: "split_files/vae/wan2.2_vae.safetensors", bytes: 1344 * MB };
const umt5Small: ImageFile = { role: "t5xxl", repo: "city96/umt5-xxl-encoder-gguf", path: "umt5-xxl-encoder-Q4_K_M.gguf", bytes: 3486 * MB };
/** The negative prompt Wan's authors give with every example. */
const WAN_NEGATIVE =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

const zImageVae: ImageFile = { role: "vae", repo: "Comfy-Org/z_image_turbo", path: "split_files/vae/ae.safetensors", bytes: 320 * MB };

/** The short list (docs/specs/local-images.md): each model checked with the engine Artel downloads. */
export const IMAGE_MODELS: ImageModelDef[] = [
  {
    id: "z-image-turbo",
    family: "z-image-turbo",
    kind: "image",
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
    family: "qwen-image-2512",
    kind: "image",
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
  {
    // Text or a picture to video, 24 frames a second; its own VAE.
    id: "wan2.2-ti2v-5b",
    family: "wan2.2-ti2v-5b",
    kind: "video",
    name: "Wan 2.2 5B",
    variants: [
      [
        { role: "diffusion", repo: "QuantStack/Wan2.2-TI2V-5B-GGUF", path: "Wan2.2-TI2V-5B-Q8_0.gguf", bytes: 5150 * MB },
        { role: "t5xxl", repo: "city96/umt5-xxl-encoder-gguf", path: "umt5-xxl-encoder-Q8_0.gguf", bytes: 5763 * MB },
        wan22Vae,
      ],
      [
        { role: "diffusion", repo: "QuantStack/Wan2.2-TI2V-5B-GGUF", path: "Wan2.2-TI2V-5B-Q4_K_M.gguf", bytes: 3274 * MB },
        umt5Small,
        wan22Vae,
      ],
    ],
    settings: { steps: 20, cfg: 6, flowShift: 3, sampler: "euler", negative: WAN_NEGATIVE, fps: 24 },
  },
  {
    // The light one: runs on most video cards, simpler motion.
    id: "wan2.1-t2v-1.3b",
    family: "wan2.1-t2v-1.3b",
    kind: "video",
    name: "Wan 2.1 1.3B",
    variants: [
      [
        { role: "diffusion", repo: "Comfy-Org/Wan_2.1_ComfyUI_repackaged", path: "split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors", bytes: 2707 * MB },
        umt5Small,
        { role: "vae", repo: "Comfy-Org/Wan_2.1_ComfyUI_repackaged", path: "split_files/vae/wan_2.1_vae.safetensors", bytes: 242 * MB },
      ],
    ],
    settings: { steps: 20, cfg: 6, flowShift: 3, sampler: "euler", negative: WAN_NEGATIVE, fps: 16 },
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

/** A clip's sides for each aspect ratio: 480p, multiples of 32 as Wan's VAE needs. */
export const VIDEO_SIZES: Record<string, [number, number]> = {
  "16:9": [832, 480],
  "9:16": [480, 832],
  "1:1": [640, 640],
};
/** How long a clip may be, in seconds: a few seconds already take minutes on a home video card. */
export const VIDEO_DURATIONS = [2, 3, 5];

/**
 * The family of a model found on Hugging Face, by its repository's and file's names: the checked model whose VAE, text
 * encoder and settings it shares. Null for a family Artel does not know: what else it needs cannot be told from a name.
 */
export function familyOf(name: string): CheckedImageModelId | null {
  if (/z[-_ ]?image[-_ ]?turbo/i.test(name)) return "z-image-turbo";
  if (/qwen[-_ ]?image/i.test(name) && !/edit|layered|vl/i.test(name)) return "qwen-image-2512";
  if (/wan[-_ ]?2\.?2/i.test(name) && /ti2v|5b/i.test(name)) return "wan2.2-ti2v-5b";
  if (/wan[-_ ]?2\.?1/i.test(name) && /t2v/i.test(name) && /1\.3b/i.test(name)) return "wan2.1-t2v-1.3b";
  return null;
}

/** How a file is packed, from its name: Q4_K_M, Q8_0, BF16… Null when the name does not say. */
export function quantOf(path: string): string | null {
  const name = path.split("/").pop()!;
  return /(?:^|[-_.])((?:UD-)?I?Q\d[\w]*?|BF16|FP16|F16|FP8|FP32|F32)(?=\.(?:gguf|safetensors)$)/i.exec(name)?.[1]?.toUpperCase() ?? null;
}

/** Not the model itself: the VAE, a text encoder or a LoRA that comes along in the repository. */
export const isComponent = (path: string) => /vae|text[-_]?encoder|clip|t5|umt5|lora|mmproj|controlnet|upscal/i.test(path);

/** A model found on Hugging Face: its own file, and the rest from the checked model of its family. */
export function foundModel(family: ImageModelDef, repo: string, path: string, bytes: number): ImageModelDef {
  const base = family.variants.at(-1)!;
  const quant = quantOf(path);
  return {
    ...family,
    id: `hf:${repo}:${path}`,
    name: `${repo.split("/")[1]}${quant ? ` · ${quant}` : ""}`,
    variants: [[{ role: "diffusion", repo, path, bytes }, ...base.filter((f) => f.role !== "diffusion")]],
  };
}

/** Where the downloaded file of a model lives: by repository, so a file two models share is downloaded once. */
export const fileKey = (f: ImageFile) => `${f.repo.replace("/", "__")}__${f.path.replace(/\//g, "__")}`;
