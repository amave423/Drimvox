import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

/** A stand-in for ComfyUI's API: its model folders, /prompt, /history, /view, /interrupt. */
async function startFakeComfy(o: { fail?: boolean } = {}) {
  const graphs: any[] = [];
  let interrupted = 0;
  const folders: Record<string, string[]> = {
    diffusion_models: ["qwen_image_2.1_int8_convrot.safetensors", "flux1-dev.safetensors"],
    text_encoders: ["qwen3vl_8b_int8_convrot.safetensors"],
    vae: ["qwen_image_2.1_vae_bf16.safetensors"],
    checkpoints: ["sd_xl_base_1.0.safetensors"],
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith("/models/")) return json(200, folders[url.pathname.slice(8)] ?? []);
    if (url.pathname === "/prompt" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      graphs.push(JSON.parse(body).prompt);
      return json(200, { prompt_id: `p${graphs.length}`, number: graphs.length });
    }
    if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.slice(9);
      if (o.fail) return json(200, { [id]: { status: { status_str: "error", messages: [["execution_error", { exception_message: "CUDA out of memory" }]] }, outputs: {} } });
      return json(200, { [id]: { status: { status_str: "success" }, outputs: { "8": { images: [{ filename: "drimvox_00001_.png", subfolder: "", type: "output" }] } } } });
    }
    if (url.pathname === "/view") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    if (url.pathname === "/interrupt") {
      interrupted++;
      return json(200, {});
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, graphs, interrupted: () => interrupted, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let env: TestEnv;
let comfy: Awaited<ReturnType<typeof startFakeComfy>> | undefined;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(async () => {
  env.close();
  await comfy?.close();
  comfy = undefined;
});

async function connect(o: { fail?: boolean } = {}) {
  comfy = await startFakeComfy(o);
  const provider = await (await env.call("POST", "/api/providers", { preset: "comfyui", name: "ComfyUI", baseUrl: comfy.url })).json();
  return provider.id as string;
}

// Asked for: engines beside stable-diffusion.cpp. ComfyUI takes new models first and in their own formats.
describe("pictures through ComfyUI", () => {
  it("lists the models Drimvox has a graph for: Qwen-Image 2.1 with its encoder and VAE, and checkpoints", async () => {
    const id = await connect();
    const models = await (await env.call("GET", `/api/providers/${id}/media-models?kind=image`)).json();
    expect(models.map((m: { id: string }) => m.id)).toEqual(["qwen-image-2.1:qwen_image_2.1_int8_convrot.safetensors", "checkpoint:sd_xl_base_1.0.safetensors"]);
    expect(models[0]).toMatchObject({ kind: "image", pricing: { lines: [{ costUsd: 0 }] } });
    expect(await (await env.call("GET", `/api/providers/${id}/media-models?kind=video`)).json()).toEqual([]);
    expect(await (await env.call("GET", `/api/providers/${id}/models`)).json()).toEqual([]);
  });

  it("draws Qwen-Image 2.1 with ComfyUI's own graph and brings the picture back", async () => {
    const id = await connect();
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "qwen-image-2.1:qwen_image_2.1_int8_convrot.safetensors", kind: "image" })).json();
    const events = await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Кот в очках", options: { aspectRatio: "16:9" } }));
    const done = events.find((e: { type: string }) => e.type === "done").message;
    expect(done).toMatchObject({ status: "done" });
    expect(done.media[0]).toMatchObject({ kind: "image", mime: "image/png", prompt: "Кот в очках" });
    const graph = comfy!.graphs[0];
    expect(graph["1"]).toMatchObject({ class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_int8_convrot.safetensors" } });
    expect(graph["2"]).toMatchObject({ class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image" } });
    expect(graph["4"]).toMatchObject({ class_type: "TextEncodeQwenImage21", inputs: { prompt: "Кот в очках" } });
    expect(graph["5"].inputs).toMatchObject({ width: 1344, height: 768 });
  });

  it("says what ComfyUI said when it could not draw", async () => {
    const id = await connect({ fail: true });
    const chat = await (await env.call("POST", "/api/chats", { providerId: id, model: "checkpoint:sd_xl_base_1.0.safetensors", kind: "image" })).json();
    const events = await readEvents(await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Дом" }));
    const done = events.find((e: { type: string }) => e.type === "done").message;
    expect(done.status).toBe("error");
    expect(done.error.detail).toMatch(/CUDA out of memory/);
    expect(comfy!.graphs[0]["1"]).toMatchObject({ class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } });
  });
});
