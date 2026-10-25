// Hugging Face and GitHub for the picture engine's tests (docs/specs/local-images.md): the short list's files, listed
// folder by folder as the real one does, and the engine's zip.
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

/** Small stand-ins for the model files, each with its checksum. */
const fileOf = (name: string) => Buffer.from(`${name} `.repeat(2000));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Hugging Face with the files of the short list (listed folder by folder, as the real one does), and the engine's
 * zip. `files` counts how often each file was downloaded.
 */
export async function startFakeHub(servers: Server[] = []): Promise<{ url: string; files: Map<string, number>; close(): Promise<void> }> {
  const files = new Map<string, number>();
  const s = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/engine.zip") {
      res.writeHead(200, { "content-type": "application/zip" });
      return res.end(Buffer.from(zipSync({ "sd-server.exe": new Uint8Array([1, 2, 3]), "stable-diffusion.dll": new Uint8Array([4]) })));
    }
    // whisper.cpp for speech on this computer (docs/specs/local-audio.md).
    if (url.pathname === "/whisper.zip") {
      res.writeHead(200, { "content-type": "application/zip" });
      return res.end(Buffer.from(zipSync({ "Release/whisper-cli.exe": new Uint8Array([1, 2, 3]), "Release/whisper.dll": new Uint8Array([4]) })));
    }
    const tree = /^\/api\/models\/([^/]+\/[^/]+)\/tree\/main(\/.*)?$/.exec(url.pathname);
    if (tree) {
      const folder = tree[2] ? tree[2].slice(1) : "";
      const names: Record<string, string[]> = {
        "leejet/Z-Image-Turbo-GGUF": ["z_image_turbo-Q4_K.gguf", "z_image_turbo-Q8_0.gguf"],
        "unsloth/Qwen3-4B-Instruct-2507-GGUF": ["Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "Qwen3-4B-Instruct-2507-Q8_0.gguf"],
        "Comfy-Org/z_image_turbo": ["split_files/vae/ae.safetensors"],
        "unsloth/Qwen-Image-2512-GGUF": ["qwen-image-2512-Q4_K_S.gguf"],
        "unsloth/Qwen2.5-VL-7B-Instruct-GGUF": ["Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf"],
        "Comfy-Org/Qwen-Image_ComfyUI": ["split_files/vae/qwen_image_vae.safetensors"],
        "QuantStack/Wan2.2-TI2V-5B-GGUF": ["Wan2.2-TI2V-5B-Q4_K_M.gguf", "Wan2.2-TI2V-5B-Q8_0.gguf"],
        "city96/umt5-xxl-encoder-gguf": ["umt5-xxl-encoder-Q4_K_M.gguf", "umt5-xxl-encoder-Q8_0.gguf"],
        "Comfy-Org/Wan_2.2_ComfyUI_Repackaged": ["split_files/vae/wan2.2_vae.safetensors"],
        // Found by the search: one of a family Drimvox knows, one it does not.
        "someone/Z-Image-Turbo-Fun-GGUF": ["z_image_turbo_fun-Q5_K_M.gguf", "z_image_turbo_fun-Q8_0.gguf", "vae/ae.safetensors"],
        "someone/flux-mystery-GGUF": ["flux-mystery-Q4_K_S.gguf"],
        "ggerganov/whisper.cpp": ["ggml-base.bin", "ggml-small-q5_1.bin", "ggml-large-v3-turbo-q5_0.bin"],
        "Comfy-Org/Wan_2.1_ComfyUI_repackaged": ["split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors", "split_files/vae/wan_2.1_vae.safetensors"],
      };
      const all = url.searchParams.get("recursive") === "true";
      const list = (names[tree[1]!] ?? [])
        .filter((p) => all || (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === folder)
        .map((p) => {
          const body = fileOf(p);
          return { type: "file", path: p, size: body.length, lfs: { oid: sha(body), size: body.length } };
        });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(list));
    }
    // The search, by what a model makes.
    if (url.pathname === "/api/models") {
      const kind = url.searchParams.get("pipeline_tag");
      const found =
        kind === "text-to-image"
          ? [
              { id: "someone/Z-Image-Turbo-Fun-GGUF", downloads: 5000, likes: 40, pipeline_tag: "text-to-image" },
              { id: "someone/flux-mystery-GGUF", downloads: 9000, likes: 90, pipeline_tag: "text-to-image" },
            ]
          : kind === "text-to-video"
            ? [{ id: "QuantStack/Wan2.2-TI2V-5B-GGUF", downloads: 7000, likes: 70, pipeline_tag: "text-to-video" }]
            : [];
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(found));
    }
    const file = /^\/[^/]+\/[^/]+\/resolve\/main\/(.+)$/.exec(url.pathname);
    if (file) {
      const path = decodeURIComponent(file[1]!);
      files.set(path, (files.get(path) ?? 0) + 1);
      const body = fileOf(path);
      res.writeHead(200, { "content-length": String(body.length) });
      return res.end(body);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, files, close: () => new Promise((r) => s.close(() => r())) };
}
