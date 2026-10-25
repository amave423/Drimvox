import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, readEvents, type TestEnv } from "./env";
import { startFakeProvider, type FakeProvider, type FakeReply, type FakeTurn } from "./fake-provider";
import { makeRepo } from "./git-repo";

const KEY = "good-key";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const MP4 = Buffer.from("000000186674797069736f6d", "hex");

let env: TestEnv;
let fake: FakeProvider | undefined;

beforeEach(() => {
  env = createTestEnv();
  env.setMediaPollMs(30);
});

afterEach(async () => {
  await env.closeAsync();
  await fake?.close();
  fake = undefined;
});

const imageModels = {
  data: [
    {
      id: "img/cheap",
      name: "Cheap Image",
      architecture: { output_modalities: ["image"] },
      supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1", "16:9"] }, resolution: { type: "enum", values: ["1K", "2K"] } },
    },
    { id: "img/dear", name: "Dear Image", architecture: { output_modalities: ["image"] }, supported_parameters: {} },
    // Takes up to four photos as references; an editing model needs at least one.
    {
      id: "img/ref",
      name: "Reference Image",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
      supported_parameters: { input_references: { type: "range", min: 0, max: 4 } },
    },
    {
      id: "img/edit",
      name: "Edit Image",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
      supported_parameters: { input_references: { type: "range", min: 1, max: 8 } },
    },
    { id: "img/unpriced", name: "Unpriced", architecture: { output_modalities: ["image"] }, supported_parameters: {} },
  ],
};
const endpoints: Record<string, unknown[]> = {
  "img/cheap": [{ billable: "output_image", unit: "image", cost_usd: 0.04 }],
  "img/dear": [{ billable: "output_image", unit: "image", cost_usd: 0.25 }],
  "img/unpriced": [],
  "img/ref": [{ billable: "output_image", unit: "image", cost_usd: 0.04 }],
  "img/edit": [{ billable: "output_image", unit: "image", cost_usd: 0.04 }],
};
const videoModels = {
  data: [
    {
      id: "vid/lite",
      name: "Lite Video",
      supported_resolutions: ["720p"],
      supported_aspect_ratios: ["16:9", "9:16"],
      supported_durations: [4, 8],
      generate_audio: true,
      pricing_skus: { duration_seconds_without_audio: "0.03", duration_seconds_with_audio: "0.05" },
      supported_frame_images: ["first_frame", "last_frame"],
    },
  ],
};

interface MediaFake {
  /** Answer of POST /images; the default is one PNG costing $0.039. */
  image?: (body: any) => FakeReply;
  /** Statuses GET /videos/:id walks through, ending with the last one. */
  videoStatuses?: string[];
  script?: FakeTurn[];
}

async function start(m: MediaFake = {}) {
  let polls = 0;
  const statuses = m.videoStatuses ?? ["pending", "in_progress", "completed"];
  fake = await startFakeProvider({
    key: KEY,
    script: m.script,
    models: [{ id: "coder", supported_parameters: ["tools"] }],
    handle: (method, path, body) => {
      if (method === "GET" && path === "/v1/images/models") return { json: imageModels };
      const ep = path.match(/^\/v1\/images\/models\/(.+)\/endpoints$/);
      if (method === "GET" && ep) return { json: { id: ep[1], endpoints: [{ provider_name: "P", pricing: endpoints[ep[1]!] }] } };
      if (method === "GET" && path === "/v1/videos/models") return { json: videoModels };
      if (method === "POST" && path === "/v1/images") {
        return m.image?.(body) ?? { json: { data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }], usage: { cost: 0.039 } } };
      }
      if (method === "POST" && path === "/v1/videos") return { status: 202, json: { id: "job-1", status: "pending", polling_url: "/v1/videos/job-1" } };
      if (method === "GET" && path === "/v1/videos/job-1") {
        const status = statuses[Math.min(polls++, statuses.length - 1)];
        return status === "completed"
          ? { json: { id: "job-1", status, unsigned_urls: [`${fake!.baseUrl}/videos/job-1/content?index=0`], usage: { cost: 0.12 } } }
          : { json: { id: "job-1", status, error: status === "failed" ? "Content policy" : undefined } };
      }
      if (method === "GET" && path === "/v1/videos/job-1/content") return { bytes: MP4, contentType: "video/mp4" };
      return undefined;
    },
  });
  const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
  return provider.id as string;
}

async function chatWith(providerId: string, model: string, kind: "image" | "video") {
  const res = await env.call("POST", "/api/chats", { providerId, model, kind });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

const send = (chatId: string, body: Record<string, unknown>) => env.call("POST", `/api/chats/${chatId}/messages`, body);

async function waitForMessage(chatId: string, check: (m: any) => boolean): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const chat = await (await env.call("GET", `/api/chats/${chatId}`)).json();
    const last = chat.messages.at(-1);
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("message never changed");
}

describe("catalog", () => {
  it("lists image and video models with what they support", async () => {
    const id = await start();
    const images = await (await env.call("GET", `/api/providers/${id}/media-models?kind=image`)).json();
    expect(images.map((m: any) => m.id)).toEqual(["img/cheap", "img/dear", "img/edit", "img/ref", "img/unpriced"]);
    expect(images[0]).toMatchObject({ kind: "image", aspectRatios: ["1:1", "16:9"], resolutions: ["1K", "2K"], pricing: null });

    const videos = await (await env.call("GET", `/api/providers/${id}/media-models?kind=video`)).json();
    expect(videos[0]).toMatchObject({ id: "vid/lite", kind: "video", durations: [4, 8], audio: true, pricing: { skus: { duration_seconds_with_audio: "0.05" } } });
  });

  it("loads the prices of one image model", async () => {
    const id = await start();
    const model = await (await env.call("GET", `/api/providers/${id}/media-models/one?kind=image&model=img/cheap`)).json();
    expect(model.pricing.lines).toEqual([{ billable: "output_image", unit: "image", costUsd: 0.04, variant: null }]);
  });

  it("has no media models where the provider has no media API", async () => {
    fake = await startFakeProvider({ key: KEY });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    expect(await (await env.call("GET", `/api/providers/${provider.id}/media-models?kind=image`)).json()).toEqual([]);
  });
});

describe("pictures in a chat", () => {
  it("draws a picture, keeps it with its price and shows it in the gallery", async () => {
    const id = await start();
    const chatId = await chatWith(id, "img/cheap", "image");
    const res = await send(chatId, { content: "Кот в очках", options: { aspectRatio: "16:9" } });
    expect(res.status).toBe(200);
    const done = (await readEvents(res)).find((e) => e.type === "done").message;
    expect(done).toMatchObject({ role: "assistant", status: "done", costUsd: 0.039, model: "img/cheap" });
    expect(done.media).toHaveLength(1);
    expect(done.media[0]).toMatchObject({ kind: "image", mime: "image/png", prompt: "Кот в очках", chatId });

    const sent = fake!.requests.find((r) => r.path === "/v1/images")!.body;
    expect(sent).toMatchObject({ model: "img/cheap", prompt: "Кот в очках", aspect_ratio: "16:9", n: 1 });

    const file = await env.call("GET", `/api/media/${done.media[0].id}/content`);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);

    const gallery = await (await env.call("GET", "/api/media")).json();
    expect(gallery.map((m: any) => m.id)).toEqual([done.media[0].id]);
    const usage = await (await env.call("GET", "/api/usage?since=0")).json();
    expect(usage.costUsd).toBeCloseTo(0.039, 6);
  });

  it("asks before a dear picture or one without a price, then draws it on confirm", async () => {
    const id = await start();
    const dear = await chatWith(id, "img/dear", "image");
    const refused = await send(dear, { content: "Замок" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: { code: "confirm", estimateUsd: 0.25 } });
    expect(fake!.requests.some((r) => r.path === "/v1/images")).toBe(false);

    const unpriced = await chatWith(id, "img/unpriced", "image");
    expect(await (await send(unpriced, { content: "Замок" })).json()).toEqual({ error: { code: "confirm", estimateUsd: null } });

    const ok = await send(dear, { content: "Замок", confirm: true });
    expect((await readEvents(ok)).find((e) => e.type === "done").message.status).toBe("done");
  });

  it("puts a provider error on the answer", async () => {
    const id = await start({ image: () => ({ status: 402, json: { error: { message: "Insufficient credits" } } }) });
    const chatId = await chatWith(id, "img/cheap", "image");
    const done = (await readEvents(await send(chatId, { content: "Кот" }))).find((e) => e.type === "done").message;
    expect(done).toMatchObject({ status: "error", error: { code: "no_funds" }, media: [] });
  });

  it("forgets a deleted picture and its file", async () => {
    const id = await start();
    const chatId = await chatWith(id, "img/cheap", "image");
    const done = (await readEvents(await send(chatId, { content: "Кот" }))).find((e) => e.type === "done").message;
    expect((await env.call("DELETE", `/api/media/${done.media[0].id}`)).status).toBe(204);
    expect((await env.call("GET", `/api/media/${done.media[0].id}/content`)).status).toBe(404);
    expect(await (await env.call("GET", "/api/media")).json()).toEqual([]);
  });
});

describe("video in a chat", () => {
  it("always asks first, waits for the job and downloads the clip", async () => {
    const id = await start();
    const chatId = await chatWith(id, "vid/lite", "video");
    expect(await (await send(chatId, { content: "Волны", options: { duration: 4 } })).json()).toEqual({
      error: { code: "confirm", estimateUsd: 0.12 },
    });

    const res = await send(chatId, { content: "Волны", options: { duration: 4, audio: false }, confirm: true });
    const first = (await readEvents(res)).find((e) => e.type === "done").message;
    expect(first.status).toBe("streaming");
    expect(fake!.requests.find((r) => r.path === "/v1/videos")!.body).toMatchObject({ model: "vid/lite", prompt: "Волны", duration: 4, generate_audio: false });

    const done = await waitForMessage(chatId, (m) => m.status !== "streaming");
    expect(done).toMatchObject({ status: "done", costUsd: 0.12 });
    expect(done.media[0]).toMatchObject({ kind: "video", mime: "video/mp4" });
    const file = await env.call("GET", `/api/media/${done.media[0].id}/content`);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(MP4);
    expect(fake!.requests.filter((r) => r.path === "/v1/videos/job-1").length).toBeGreaterThanOrEqual(3);
  });

  it("reports a failed job", async () => {
    const id = await start({ videoStatuses: ["pending", "failed"] });
    const chatId = await chatWith(id, "vid/lite", "video");
    await readEvents(await send(chatId, { content: "Волны", confirm: true }));
    const done = await waitForMessage(chatId, (m) => m.status !== "streaming");
    expect(done).toMatchObject({ status: "error", error: { code: "provider_error", detail: "Content policy" }, media: [] });
  });

  it("keeps waiting for a job after a restart", async () => {
    const id = await start({ videoStatuses: ["pending", "pending", "pending", "pending", "pending", "pending", "completed"] });
    const chatId = await chatWith(id, "vid/lite", "video");
    await readEvents(await send(chatId, { content: "Волны", confirm: true }));
    env.reopen();
    env.setMediaPollMs(30);
    await env.call("GET", "/api/health");
    const done = await waitForMessage(chatId, (m) => m.status !== "streaming");
    expect(done.media[0].kind).toBe("video");
  });
});

describe("pictures made by an agent", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo({ "index.html": "<h1>Hi</h1>\n" });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  async function runTask(script: FakeTurn[], model = "img/cheap") {
    const id = await start({ script });
    await env.call("PATCH", "/api/settings", { imageModel: { providerId: id, model } });
    const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
    const stages = { interview: false, spec: false, approveSpec: false, testsFirst: false };
    const task = await (await env.call("POST", `/api/projects/${project.id}/tasks`, { task: "Сделай логотип", providerId: id, model: "coder", stages })).json();
    return task.id as string;
  }
  const waitTask = async (id: string, check: (t: any) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const t = await (await env.call("GET", `/api/tasks/${id}`)).json();
      if (check(t)) return t;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("task stuck");
  };
  const draw = { toolCalls: [{ name: "generate_image", args: { prompt: "Логотип: лиса", path: "assets/logo.png", aspect_ratio: "1:1" } }] };
  const finish = { toolCalls: [{ name: "finish", args: { summary: "Логотип готов", commit_message: "Add logo" } }] };

  it("draws a cheap picture into the copy, charges the task and shows it in review", async () => {
    const id = await runTask([draw, finish]);
    const task = await waitTask(id, (t) => t.status === "review");
    expect(task.costUsd).toBeGreaterThanOrEqual(0.039);

    const diff = await (await env.call("GET", `/api/tasks/${id}/diff`)).json();
    expect(diff.find((f: any) => f.path === "assets/logo.png")).toMatchObject({ binary: true });
    const file = await env.call("GET", `/api/tasks/${id}/file?path=assets/logo.png`);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);

    const gallery = await (await env.call("GET", "/api/media")).json();
    expect(gallery[0]).toMatchObject({ kind: "image", taskId: id, path: "assets/logo.png", prompt: "Логотип: лиса" });
    expect(existsSync(join(repo, "assets/logo.png"))).toBe(false);
  });

  it("asks before a dear picture and draws nothing when refused", async () => {
    const id = await runTask([draw, finish], "img/dear");
    const waiting = await waitTask(id, (t) => t.pendingApproval);
    expect(waiting.pendingApproval).toMatchObject({ reason: "media_cost" });
    expect(waiting.pendingApproval.command).toContain("$0.25");
    await env.call("POST", `/api/tasks/${id}/approvals/${waiting.pendingApproval.id}`, { allow: false });
    await waitTask(id, (t) => t.status === "done_empty");
    expect(fake!.requests.some((r) => r.path === "/v1/images")).toBe(false);
  });

  it("has no picture tool without a model for it in the settings", async () => {
    const id = await start({ script: [finish] });
    const project = await (await env.call("POST", "/api/projects", { path: repo })).json();
    const stages = { interview: false, spec: false, approveSpec: false, testsFirst: false };
    await env.call("POST", `/api/projects/${project.id}/tasks`, { task: "x", providerId: id, model: "coder", stages });
    for (let i = 0; i < 100 && !fake!.requests.some((r) => r.path === "/v1/chat/completions"); i++) await new Promise((r) => setTimeout(r, 20));
    const tools = fake!.requests.find((r) => r.path === "/v1/chat/completions")!.body.tools.map((t: any) => t.function.name);
    expect(tools).not.toContain("generate_image");
  });
});

// Photos for pictures and clips (docs/specs/media.md): only to a model that says it takes them; the others say they do not.
describe("photos", () => {
  const upload = async (chatId: string) =>
    (await (await env.call("POST", `/api/chats/${chatId}/attachments`, { name: "face.png", type: "image/png", data: PNG.toString("base64") })).json()).id as string;

  it("tells which models take photos, and how many", async () => {
    const id = await start();
    const images = await (await env.call("GET", `/api/providers/${id}/media-models?kind=image`)).json();
    const of = (m: string) => images.find((x: any) => x.id === m).photos;
    expect(of("img/cheap")).toBeNull();
    expect(of("img/ref")).toEqual({ use: "reference", min: 0, max: 4 });
    expect(of("img/edit")).toEqual({ use: "reference", min: 1, max: 8 });
    const videos = await (await env.call("GET", `/api/providers/${id}/media-models?kind=video`)).json();
    expect(videos[0].photos).toEqual({ use: "first_frame", min: 0, max: 1 });
  });

  it("sends a photo to a model that takes references", async () => {
    const id = await start();
    const chatId = await chatWith(id, "img/ref", "image");
    const photo = await upload(chatId);
    const res = await send(chatId, { content: "Этот человек в космосе", attachments: [photo] });
    expect(res.status).toBe(200);
    await readEvents(res);
    const sent = fake!.requests.find((r) => r.path === "/v1/images")!.body;
    expect(sent.input_references).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } }]);
  });

  it("does not send a photo to a model that cannot take one, and says so", async () => {
    const id = await start();
    const chatId = await chatWith(id, "img/cheap", "image");
    const photo = await upload(chatId);
    const res = await send(chatId, { content: "Этот человек в космосе", attachments: [photo] });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("no_photo_input");
    expect(fake!.requests.some((r) => r.path === "/v1/images")).toBe(false);
  });

  it("asks for a photo where the model needs one", async () => {
    const id = await start();
    const chatId = await chatWith(id, "img/edit", "image");
    const res = await send(chatId, { content: "Сделай фон синим" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("photo_required");
  });

  it("starts a clip from a photo", async () => {
    const id = await start();
    const chatId = await chatWith(id, "vid/lite", "video");
    const photo = await upload(chatId);
    const res = await send(chatId, { content: "Он улыбается", attachments: [photo], confirm: true });
    expect(res.status).toBe(200);
    await readEvents(res);
    const sent = fake!.requests.find((r) => r.path === "/v1/videos")!.body;
    expect(sent.frame_images).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` }, frame_type: "first_frame" }]);
  });
});

// Seen live: custom providers listed picture and video models among the chat models; their media tabs were empty.
describe("a custom provider with one list of models", () => {
  const listed = {
    data: [
      { id: "gpt-5-mini", name: "GPT-5 mini" },
      { id: "flux-1.1-pro", name: "FLUX 1.1 Pro" },
      { id: "gemini-2.5-flash-image", name: "Nano Banana" },
      { id: "veo-3.1", name: "Veo 3.1" },
    ],
  };

  it("keeps picture and video models out of the chat models and offers the pictures in their own tab", async () => {
    let asked: any = null;
    fake = await startFakeProvider({
      key: KEY,
      handle: (method, path, body) => {
        if (method === "GET" && path === "/v1/models") return { json: listed };
        if (method === "POST" && path === "/v1/images/generations") {
          asked = body;
          return { json: { data: [{ b64_json: PNG.toString("base64") }] } };
        }
        return undefined;
      },
    });
    const provider = await (await env.call("POST", "/api/providers", { preset: "custom", baseUrl: fake.baseUrl, apiKey: KEY })).json();
    const chatModels = await (await env.call("GET", `/api/providers/${provider.id}/models`)).json();
    expect(chatModels.map((m: { id: string }) => m.id)).toEqual(["gpt-5-mini"]);
    const images = await (await env.call("GET", `/api/providers/${provider.id}/media-models?kind=image`)).json();
    expect(images.map((m: { id: string }) => m.id)).toEqual(["flux-1.1-pro", "gemini-2.5-flash-image"]);

    const chat = await (await env.call("POST", "/api/chats", { providerId: provider.id, model: "flux-1.1-pro", kind: "image" })).json();
    const res = await env.call("POST", `/api/chats/${chat.id}/messages`, { content: "Кот", confirm: true });
    const done = (await readEvents(res)).find((e) => e.type === "done").message;
    expect(done.media).toHaveLength(1);
    expect(asked).toMatchObject({ model: "flux-1.1-pro", prompt: "Кот", response_format: "b64_json" });
  });
});

// Asked for: a text model that knows the picture model, writes the prompt itself, looks at the result and redoes it, as
// many times as the user allows.
describe("a director for pictures", () => {
  it("writes the prompt, looks at each picture and redraws within the attempts the user gave", async () => {
    const prompts: string[] = [];
    const providerId = await start({
      image: (body) => {
        prompts.push(body.prompt);
        return { json: { data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }], usage: { cost: 0.039 } } };
      },
      script: [
        { toolCalls: [{ name: "make_picture", args: { prompt: "A ginger cat on a windowsill, soft morning light" } }] },
        // The director's own look at the picture.
        { text: "Рыжий кот на подоконнике, но без очков." },
        { toolCalls: [{ name: "make_picture", args: { prompt: "A ginger cat wearing round glasses on a windowsill, soft morning light" } }] },
        { text: "Рыжий кот в круглых очках на подоконнике." },
        // A third try would go past the two the user allowed.
        { toolCalls: [{ name: "make_picture", args: { prompt: "One more" } }] },
        { text: "Готово: кот в очках, вторая попытка." },
      ],
    });
    const chatId = await chatWith(providerId, "img/cheap", "image");
    const res = await send(chatId, { content: "Кот в очках", director: { providerId, model: "coder", attempts: 2 }, confirm: true });
    expect(res.status).toBe(200);
    const done = (await readEvents(res)).find((e) => e.type === "done").message;
    expect(prompts).toEqual(["A ginger cat on a windowsill, soft morning light", "A ginger cat wearing round glasses on a windowsill, soft morning light"]);
    expect(done).toMatchObject({ status: "done", content: "Готово: кот в очках, вторая попытка." });
    expect(done.media).toHaveLength(2);
    // The director was told about the picture model it works with.
    const first = fake!.requests.find((r) => r.path === "/v1/chat/completions")!;
    expect(JSON.stringify(first.body.messages)).toMatch(/Cheap Image/);
  });

  it("asks before spending more than the confirmation limit across all its attempts", async () => {
    const providerId = await start();
    const chatId = await chatWith(providerId, "img/cheap", "image");
    // Three attempts of $0.04 are more than $0.10.
    const res = await send(chatId, { content: "Кот", director: { providerId, model: "coder", attempts: 3 } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "confirm" } });
  });
});
